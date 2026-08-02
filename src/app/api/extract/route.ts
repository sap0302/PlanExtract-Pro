import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createProvider,
  extractFromPDFChunked,
  isPdfProcessingError,
  applyVerificationCorrections,
  applyNameCorrections,
  processVerificationAdditions,
} from "@/lib/providers";
import type { Provider } from "@/lib/providers";
import { decrypt } from "@/lib/encryption";
import { stringifyJsonArray } from "@/lib/json-fields";
import { buildUserPromptWithExamples } from "@/lib/prompts";
import type { ExtractedItem, VerificationResult, AIProvider } from "@/lib/providers/types";
import { mergeExtractionsNWay, type LabeledResult } from "@/lib/providers/consensus";
import {
  splitPdfForClaude,
  extractPageRanges,
  parsePageRanges,
  getPdfPageCount,
} from "@/lib/pdf-utils";

const VALID_PROVIDERS = ["anthropic", "openai", "gemini"] as const;

const SYS_MAP: Record<string, string> = {
  water: "Water",
  storm_drain: "Storm Drain",
  wastewater: "Wastewater",
  other: "Other",
};
const TYPE_MAP: Record<string, string> = {
  area: "Area",
  count: "Count",
  linear: "Linear",
};

/** Compute a PlanSwift-style folder path from system + measurementType + isDemo. */
function computeFolderPath(item: ExtractedItem): string {
  const typeLabel = TYPE_MAP[item.measurementType] || "Other";
  if (item.isDemo) return `Demolition/${typeLabel}`;
  const sysLabel = SYS_MAP[item.system] || "Other";
  return `${sysLabel}/${typeLabel}`;
}

/** Format verification diagnostics into a storable JSON string. */
function formatVerificationDiagnostics(
  vr: VerificationResult
): string | null {
  const diag: Record<string, unknown> = {};
  if (vr.connectivityIssues?.length) diag.connectivityIssues = vr.connectivityIssues;
  if (vr.scopeChecks?.length) diag.scopeChecks = vr.scopeChecks;
  if (vr.topUncertainties?.length) diag.topUncertainties = vr.topUncertainties;
  if (vr.dedupFlags?.length) diag.dedupFlags = vr.dedupFlags;
  if (Object.keys(diag).length === 0) return null;
  return JSON.stringify(diag);
}

export async function POST(req: Request) {
  const extractionStartTime = Date.now();

  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const name = (formData.get("name") as string) || "Untitled Extraction";
    const pageRangesStr = (formData.get("pageRanges") as string) || "";
    const enableVerification = formData.get("enableVerification") === "true";
    const requestedProvider = (formData.get("provider") as string) || "";
    const scale = (formData.get("scale") as string) || "";

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.type !== "application/pdf") {
      return NextResponse.json(
        { error: "Only PDF files are accepted" },
        { status: 400 }
      );
    }

    const maxSize = 150 * 1024 * 1024; // 150MB
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: "File size exceeds 150MB limit" },
        { status: 400 }
      );
    }

    // Load user settings (keys + preferred provider)
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        id: true,
        anthropicKeyEnc: true,
        openaiKeyEnc: true,
        geminiKeyEnc: true,
        preferredProvider: true,
        geminiModel: true,
        claudeModel: true,
        openaiModel: true,
        customInstructions: true,
      },
    });

    if (!user) {
      return NextResponse.json(
        { error: "Session expired. Please sign out and log in again." },
        { status: 401 }
      );
    }

    // Resolve which provider to use:
    // 1. "consensus" → use all available providers
    // 2. Explicitly requested in form → use that
    // 3. User's preferred provider → use that
    // 4. Fallback → "anthropic"
    const isConsensusMode = requestedProvider === "consensus";

    let selectedProvider: Provider;
    if (
      !isConsensusMode &&
      requestedProvider &&
      VALID_PROVIDERS.includes(requestedProvider as Provider)
    ) {
      selectedProvider = requestedProvider as Provider;
    } else {
      selectedProvider = (user.preferredProvider as Provider) || "anthropic";
    }

    // Resolve API keys for available providers
    const keyFieldMap: Record<Provider, string | null> = {
      anthropic: user.anthropicKeyEnc,
      openai: user.openaiKeyEnc,
      gemini: user.geminiKeyEnc,
    };

    // Helper to resolve a key for a provider
    const resolveKey = (p: Provider): string | null => {
      const enc = keyFieldMap[p];
      if (enc) {
        try { return decrypt(enc); } catch { return null; }
      }
      if (p === "anthropic") return process.env.ANTHROPIC_API_KEY || null;
      return null;
    };

    // Helper to resolve model for a provider (user preference → env → provider default)
    const modelMap: Record<Provider, string | null | undefined> = {
      anthropic: user.claudeModel,
      openai: user.openaiModel,
      gemini: user.geminiModel,
    };
    const resolveModel = (p: Provider): string | undefined => {
      const userModel = modelMap[p];
      if (userModel) return userModel;
      // Fallback to env for Anthropic
      if (p === "anthropic") return process.env.CLAUDE_MODEL || undefined;
      return undefined;
    };

    // Build consensus providers array (or single provider)
    let aiProvider: AIProvider;
    let consensusProviders: Array<{ provider: Provider; instance: AIProvider }> = [];

    if (isConsensusMode) {
      // Collect all providers with valid API keys
      for (const p of VALID_PROVIDERS) {
        const key = resolveKey(p);
        if (key) {
          consensusProviders.push({ provider: p, instance: createProvider(p, key, resolveModel(p)) });
        }
      }
      if (consensusProviders.length < 2) {
        return NextResponse.json(
          { error: `Consensus mode requires at least 2 configured providers. Found ${consensusProviders.length}. Go to Settings to add API keys.` },
          { status: 400 }
        );
      }
      // Use the first provider as the primary (for verification, etc.)
      aiProvider = consensusProviders[0].instance;
      selectedProvider = consensusProviders[0].provider;
      console.log(`[consensus] Using ${consensusProviders.length} providers: ${consensusProviders.map(p => p.provider).join(", ")}`);
    } else {
      const apiKey = resolveKey(selectedProvider);
      if (!apiKey) {
        const providerLabels: Record<Provider, string> = {
          anthropic: "Anthropic",
          openai: "OpenAI",
          gemini: "Google Gemini",
        };
        return NextResponse.json(
          { error: `No API key configured for ${providerLabels[selectedProvider]}. Go to Settings to add your API key.` },
          { status: 400 }
        );
      }
      aiProvider = createProvider(selectedProvider, apiKey, resolveModel(selectedProvider));
      console.log(`[extract] Using ${selectedProvider} with model: ${resolveModel(selectedProvider) || "(default)"}`);
    }

    // Create extraction record
    const extraction = await prisma.extraction.create({
      data: {
        name,
        fileName: file.name,
        fileSize: file.size,
        status: "processing",
        provider: isConsensusMode
          ? `consensus(${consensusProviders.map((p) => p.provider).join("+")})`
          : selectedProvider,
        userId: session.user.id,
      },
    });

    try {
      // Fetch active reference examples for few-shot prompting
      const activeExamples = await prisma.referenceExample.findMany({
        where: { userId: session.user.id, isActive: true },
        orderBy: { createdAt: "asc" },
        select: { name: true, projectType: true, rawText: true },
      });
      const userPrompt = buildUserPromptWithExamples(activeExamples, user.customInstructions, scale);
      if (activeExamples.length > 0) {
        console.log(
          `Using ${activeExamples.length} reference example(s) for few-shot prompting`
        );
      }

      // Convert to buffer
      const arrayBuffer = await file.arrayBuffer();
      const rawBuffer = Buffer.from(arrayBuffer);

      // If user specified page ranges, extract only those pages
      let processBuffer: Uint8Array;
      let usedPageRangeExtraction = false;
      if (pageRangesStr.trim()) {
        // IMPORTANT: no silent fallback to the full PDF here.
        //
        // Previously this block caught any extraction failure and silently
        // reverted to the full PDF, which meant users who asked for pages
        // 1-5, 15-25 could end up getting ALL pages extracted without
        // knowing it. Scope-creep in their takeoff was invisible.
        //
        // Instead: try the primary extraction, and on failure fail LOUDLY
        // with a 400 so the user sees exactly why. The user can then adjust
        // their page range, try a cleaner PDF, or remove the page-range
        // restriction intentionally.
        const totalPages = await getPdfPageCount(rawBuffer);
        let ranges: Array<[number, number]>;
        try {
          ranges = parsePageRanges(pageRangesStr, totalPages);
        } catch (parseErr) {
          const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          console.warn(`[extract] parsePageRanges failed for "${pageRangesStr}":`, msg);
          return NextResponse.json(
            {
              error: `Invalid page range "${pageRangesStr}": ${msg}`,
              hint: "Use formats like \"1-5\" (single range), \"1-5, 15-25\" (multiple ranges), or \"3, 7, 12\" (individual pages). All page numbers must be within 1-" + totalPages + ".",
            },
            { status: 400 }
          );
        }

        try {
          processBuffer = await extractPageRanges(rawBuffer, ranges);
          usedPageRangeExtraction = true;
          console.log(
            `[extract] Extracted pages [${pageRangesStr}] from ${totalPages}-page PDF (${(processBuffer.length / 1024 / 1024).toFixed(1)} MB result)`
          );
        } catch (extractErr) {
          const msg = extractErr instanceof Error ? extractErr.message : String(extractErr);
          console.warn(`[extract] extractPageRanges failed for [${pageRangesStr}]:`, msg);
          return NextResponse.json(
            {
              error: `Page-range extraction failed: ${msg}`,
              hint: "This PDF may have complex internal structure that pdf-lib can't extract from. Try a narrower range, upload the full PDF without page-range filter, or re-export the source PDF from its authoring tool.",
              pagesRequested: pageRangesStr,
              totalPages,
            },
            { status: 400 }
          );
        }
      } else {
        processBuffer = rawBuffer;
      }

      // Check if the PDF needs splitting
      const base64Size = Math.ceil(processBuffer.length * 1.34);
      // When HIGH_DPI_RENDER is enabled, images are much larger than raw PDF —
      // use smaller chunks (~5MB of source PDF = ~25MB of rendered images)
      const highDpiMode =
        selectedProvider === "anthropic" && process.env.HIGH_DPI_RENDER !== "false";
      // Gemini inlineData limit is 20MB (not 100MB — that's their File API).
      // For larger PDFs, smart chunking kicks in automatically.
      const maxBase64Size = highDpiMode
        ? 5 * 1024 * 1024 // 5MB for high-DPI mode (rendered images ~5x larger)
        : selectedProvider === "gemini"
          ? 25 * 1024 * 1024 // Gemini: 20MB inline limit → 25MB base64 (~19MB raw)
          : 28 * 1024 * 1024; // Anthropic: 32MB request limit → 28MB base64 PDF leaves ~4MB for prompt + tools (~21MB raw PDF)

      let result;

      // Retry callback: updates extraction status so the user sees rate-limit waits
      const onRetry = async (attempt: number, waitSeconds: number) => {
        await prisma.extraction.update({
          where: { id: extraction.id },
          data: {
            summary: `Rate limited by API. Retrying in ${waitSeconds}s (attempt ${attempt}/3)...`,
          },
        });
      };

      if (base64Size <= maxBase64Size) {
        // Small enough to process in one go
        const pdfBase64 = Buffer.from(processBuffer).toString("base64");

        if (isConsensusMode && consensusProviders.length >= 2) {
          // === CONSENSUS MODE: run all providers in parallel ===
          const providerNames = consensusProviders.map((p) => p.provider).join(", ");
          await prisma.extraction.update({
            where: { id: extraction.id },
            data: { summary: `Consensus extraction with ${consensusProviders.length} providers (${providerNames})...` },
          });

          const results = await Promise.allSettled(
            consensusProviders.map(async ({ provider: pName, instance }) => {
              await prisma.extraction.update({
                where: { id: extraction.id },
                data: { summary: `Extracting with ${pName}...` },
              });
              const r = await instance.extractFromPDF(pdfBase64, userPrompt, onRetry);
              console.log(`[consensus] ${pName}: ${r.items.length} items`);
              return { provider: pName, result: r } as LabeledResult;
            })
          );

          // Collect successful results
          const successful: LabeledResult[] = [];
          for (const r of results) {
            if (r.status === "fulfilled") successful.push(r.value);
            else console.warn(`[consensus] Provider failed:`, r.reason);
          }

          if (successful.length === 0) {
            throw new Error("All providers failed during consensus extraction");
          }

          if (successful.length === 1) {
            console.warn(`[consensus] Only 1 provider succeeded, using single result`);
            result = successful[0].result;
          } else {
            await prisma.extraction.update({
              where: { id: extraction.id },
              data: { summary: `Merging results from ${successful.length} providers...` },
            });
            result = mergeExtractionsNWay(successful);
          }
        } else {
          // === SINGLE PROVIDER MODE ===
          await prisma.extraction.update({
            where: { id: extraction.id },
            data: { summary: `Analyzing plan with ${aiProvider.name}...` },
          });

          try {
            result = await aiProvider.extractFromPDF(
              pdfBase64,
              userPrompt,
              onRetry
            );
          } catch (pdfError) {
            // If we used page-range extraction and the provider can't process the result,
            // retry with the original unmanipulated PDF
            if (usedPageRangeExtraction && isPdfProcessingError(pdfError)) {
              console.warn(
                "[extract] Page-extracted PDF failed at API. Retrying with original PDF..."
              );
              await prisma.extraction.update({
                where: { id: extraction.id },
                data: { summary: "Retrying with original PDF..." },
              });
              const originalBase64 = rawBuffer.toString("base64");
              result = await aiProvider.extractFromPDF(
                originalBase64,
                userPrompt,
                onRetry
              );
            } else {
              throw pdfError;
            }
          }
        }
      } else {
        // Split into chunks and process each
        console.log(
          `PDF is ${(processBuffer.length / 1024 / 1024).toFixed(1)}MB raw ` +
            `(~${(base64Size / 1024 / 1024).toFixed(1)}MB base64). Splitting...`
        );

        let chunks;
        try {
          chunks = await splitPdfForClaude(
            Buffer.from(processBuffer),
            maxBase64Size
          );
        } catch (splitError) {
          if (usedPageRangeExtraction) {
            console.warn(
              "[extract] Splitting page-extracted PDF failed. Trying original PDF..."
            );
            chunks = await splitPdfForClaude(rawBuffer, maxBase64Size);
          } else {
            throw splitError;
          }
        }
        console.log(`Split into ${chunks.length} chunks`);

        await prisma.extraction.update({
          where: { id: extraction.id },
          data: {
            summary: `Processing ${chunks.length} chunks with ${aiProvider.name}...`,
          },
        });

        const pdfChunks = chunks.map((c) => c.buffer.toString("base64"));
        const chunkLabels = chunks.map((c) => c.label);
        const chunkStartPages = chunks.map((c) => c.startPage);

        // ── Free the raw chunk sub-buffers ──
        // We've already converted each chunk's buffer to base64 above, so the
        // raw Buffer objects inside `chunks[i].buffer` are no longer needed.
        // For a 100+ MB PDF with 10 chunks of ~21 MB each, that's ~210 MB of
        // Buffer memory still held by the array. Nulling these lets V8
        // reclaim it before chunked extraction starts processing, which
        // reduces peak memory pressure and helps avoid "Zone Allocation
        // failed" OOM on large PDFs.
        //
        // NOTE: rawBuffer and processBuffer are intentionally kept alive —
        // they're still referenced later for PDF persistence (line 758) and
        // verification retry fallback.
        for (const c of chunks) {
          // @ts-expect-error — intentionally clearing readonly field to free memory
          c.buffer = null;
        }
        if (typeof global.gc === "function") global.gc();

        result = await extractFromPDFChunked(
          aiProvider,
          pdfChunks,
          chunkLabels,
          chunkStartPages,
          async (chunkIndex, totalChunks, label) => {
            await prisma.extraction.update({
              where: { id: extraction.id },
              data: {
                summary: `Processing chunk ${chunkIndex + 1} of ${totalChunks} (${label})...`,
              },
            });
          },
          userPrompt,
          onRetry,
          enableVerification,
          user.customInstructions
        );
      }

      // Validate & sanitize items before saving
      const items = Array.isArray(result.items) ? result.items : [];
      const validItems = items.filter((item) => {
        if (!item.name || typeof item.name !== "string" || !item.name.trim()) {
          console.warn(
            "[extract] Dropping item with missing/empty name:",
            JSON.stringify(item)
          );
          return false;
        }
        if (!item.measurementType || !item.system || !item.unit) {
          console.warn(
            "[extract] Dropping item with missing required field:",
            item.name
          );
          return false;
        }
        return true;
      });

      let sanitizedItems = validItems.map((item) => ({
        ...item,
        name: item.name.trim(),
        quantity:
          typeof item.quantity === "number" && !isNaN(item.quantity)
            ? item.quantity
            : 0,
        confidence: item.confidence || "medium",
      }));

      const droppedCount = items.length - sanitizedItems.length;
      if (droppedCount > 0) {
        console.warn(
          `[extract] Dropped ${droppedCount} invalid item(s) from extraction results`
        );
      }

      if (sanitizedItems.length === 0) {
        console.warn(
          `[extract] ZERO items extracted from "${name}" (${file.name}, ` +
            `${(file.size / 1024 / 1024).toFixed(1)}MB). ` +
            `Provider: ${selectedProvider}. ` +
            `The PDF may not contain civil plan sheets, or civil content was misidentified.`
        );
      }

      // ─── Round-Number Hallucination Detection ────────────────────────
      // Round numbers (100, 200, 500, etc.) on LINEAR/AREA items are a strong
      // hallucination signal. If ≥70% of these items have round quantities,
      // the extraction is likely fabricated.
      if (sanitizedItems.length > 0) {
        const linearAreaItems = sanitizedItems.filter(
          (i) => i.measurementType === "linear" || i.measurementType === "area"
        );
        const roundCount = linearAreaItems.filter((i) => {
          const q = i.quantity;
          return q >= 10 && q === Math.round(q) && q % 10 === 0;
        }).length;

        if (
          linearAreaItems.length >= 3 &&
          roundCount / linearAreaItems.length >= 0.7
        ) {
          console.warn(
            `[extract] HALLUCINATION WARNING: ${roundCount}/${linearAreaItems.length} ` +
              `linear/area items have suspicious round quantities. Downgrading confidence.`
          );
          sanitizedItems = sanitizedItems.map((item) => ({
            ...item,
            confidence:
              item.measurementType === "linear" ||
              item.measurementType === "area"
                ? "low"
                : item.confidence,
          }));
          result.summary +=
            " (Warning: Most quantities appear estimated — round numbers detected. Results may be inaccurate.)";
        }

        // ─── Station Math Hallucination Detection ────────────────────────
        // Station math should produce decimal pipe lengths (239.84, 42.75) NOT whole numbers.
        // If an item claims quantityMethod="station_math" but has a whole-foot quantity,
        // the AI is lying about where the number came from.
        const stationMathItems = sanitizedItems.filter(
          (i) => i.quantityMethod === "station_math" && i.measurementType === "linear"
        );
        const fakeStationMath = stationMathItems.filter((i) => {
          const q = i.quantity;
          return q >= 20 && q === Math.round(q) && q % 5 === 0;
        });

        if (fakeStationMath.length > 0) {
          console.warn(
            `[extract] FAKE STATION MATH: ${fakeStationMath.length} items claim station_math ` +
              `but have round quantities (likely fabricated): ${fakeStationMath.map(i => `${i.name}=${i.quantity}`).join(", ")}`
          );
          sanitizedItems = sanitizedItems.map((item) => {
            if (
              item.quantityMethod === "station_math" &&
              item.measurementType === "linear" &&
              item.quantity >= 20 &&
              item.quantity === Math.round(item.quantity) &&
              item.quantity % 5 === 0
            ) {
              return {
                ...item,
                confidence: "low",
                quantityMethod: "scale_estimate" as const,
                assumptions: [
                  ...(item.assumptions || []),
                  "Claimed station_math but round number suggests the AI did not actually read station values from a profile sheet",
                ],
              };
            }
            return item;
          });
        }
      }

      // ─── Two-Pass Verification ──────────────────────────────────────
      // Only for single-request PDFs (not chunked) with the toggle enabled.
      let verificationApplied = false;
      let verificationDiagnosticsJson: string | null = null;
      if (
        enableVerification &&
        sanitizedItems.length > 0 &&
        base64Size <= maxBase64Size
      ) {
        await prisma.extraction.update({
          where: { id: extraction.id },
          data: { summary: "Verifying quantities (pass 2 of 2)..." },
        });

        try {
          const pdfBase64ForVerification =
            Buffer.from(processBuffer).toString("base64");

          const verificationResult = await aiProvider.verifyExtraction(
            pdfBase64ForVerification,
            sanitizedItems,
            onRetry,
            user.customInstructions
          );

          let totalChanges = 0;

          // 1. Apply quantity corrections
          if (verificationResult.corrections.length > 0) {
            const { correctedItems, correctionCount } =
              applyVerificationCorrections(
                sanitizedItems,
                verificationResult.corrections
              );
            sanitizedItems = correctedItems;
            totalChanges += correctionCount;
            console.log(
              `Verification applied ${correctionCount} quantity correction(s)`
            );
          }

          // 2. Apply name corrections
          if (verificationResult.nameCorrections?.length > 0) {
            const { renamedItems, renameCount } = applyNameCorrections(
              sanitizedItems,
              verificationResult.nameCorrections
            );
            sanitizedItems = renamedItems;
            totalChanges += renameCount;
            console.log(
              `Verification applied ${renameCount} name correction(s)`
            );
          }

          // 3. Add missed items
          if (verificationResult.additions?.length > 0) {
            const newItems = processVerificationAdditions(
              verificationResult.additions
            );
            if (newItems.length > 0) {
              sanitizedItems = [...sanitizedItems, ...newItems];
              totalChanges += newItems.length;
              console.log(
                `Verification added ${newItems.length} missed item(s)`
              );
            }
          }

          verificationApplied = true;
          verificationDiagnosticsJson = formatVerificationDiagnostics(verificationResult);
          if (totalChanges > 0) {
            console.log(
              `Verification complete — ${totalChanges} total change(s)`
            );
          } else {
            console.log("Verification complete — no changes needed");
          }

          if (verificationResult.verificationNotes) {
            console.log(
              `Verification notes: ${verificationResult.verificationNotes}`
            );
          }

          if (verificationDiagnosticsJson) {
            console.log(
              `Verification diagnostics stored: ${verificationDiagnosticsJson.length} chars`
            );
          }
        } catch (verifyError) {
          // Verification failure is non-fatal — log and continue with original items
          console.warn(
            "[extract] Verification pass failed:",
            verifyError instanceof Error
              ? verifyError.message
              : verifyError
          );
        }
      }

      // Build final summary (append warnings if items were dropped or zero results)
      let finalSummary = result.summary;

      if (droppedCount > 0) {
        finalSummary += ` (Note: ${droppedCount} item(s) were dropped due to missing data)`;
      }

      if (sanitizedItems.length === 0) {
        finalSummary +=
          " WARNING: No items were extracted. This can happen when: (1) the PDF contains no civil plan sheets (C-series), " +
          "(2) civil sheets were misidentified as non-extractable, or " +
          "(3) the file is a multi-discipline site package where civil pages are in a different section. " +
          "Try re-uploading with specific page ranges targeting the civil sheets.";
      }

      // Post-extraction scale estimate audit — flag suspicious quantities
      for (const item of sanitizedItems) {
        if (item.quantityMethod === "scale_estimate") {
          const flags: string[] = [];

          // Flag service lines over 200 FT (typically 15-150 FT)
          if (
            /POLY|COPPER|K COP/i.test(item.name) &&
            item.quantity > 200
          ) {
            item.confidence = "low";
            flags.push(
              `Scale estimate ${item.quantity} FT flagged: service lines typically 15-150 FT`
            );
          }

          // Flag rip rap over 500 SQ FT (typically 20-500 SQ FT)
          if (/RIP RAP/i.test(item.name) && item.quantity > 500) {
            item.confidence = "low";
            flags.push(
              `Scale estimate ${item.quantity} SQ FT flagged: rip rap typically 20-500 SQ FT`
            );
          }

          // Flag round-number scale estimates >= 50 (likely hallucinated)
          if (item.quantity >= 50 && item.quantity % 25 === 0) {
            item.confidence = "low";
            flags.push(
              `Round number ${item.quantity} from scale_estimate — may be approximate`
            );
          }

          if (flags.length > 0) {
            item.assumptions = [...(item.assumptions || []), ...flags];
          }
        }
      }

      // ── Save results to database ──
      // Split into three separate writes to avoid transaction timeouts:
      //
      // 1. Items (fast): ~100 small rows via createMany. Keep in a brief
      //    transaction so all-or-nothing on item creation.
      // 2. Extraction metadata WITHOUT pdfData (fast): marks the extraction
      //    completed so the user can see the results immediately in the UI.
      // 3. pdfData BLOB (slow, large PDFs especially on OneDrive-synced
      //    SQLite): written separately so its 100+ MB write doesn't block
      //    or time out the other writes. If this step fails, the extraction
      //    is still complete and usable — only the cached PDF for later
      //    re-extract/scale/region features is missing.
      if (sanitizedItems.length > 0) {
        await prisma.item.createMany({
          data: sanitizedItems.map((item, index) => ({
            name: item.name,
            description: item.description || null,
            measurementType: item.measurementType,
            system: item.system,
            quantity: item.quantity,
            unit: item.unit,
            confidence: item.confidence,
            costEach: 0,
            markupPercent: 0,
            priceEach: 0,
            priceTotal: 0,
            sortOrder: index,
            extractionId: extraction.id,
            // ── Audit & traceability fields ──
            sourcePages: stringifyJsonArray(item.sourcePages),
            sourceSheetId: item.sourceSheetId || null,
            quantityMethod: item.quantityMethod || null,
            evidence: item.evidence || null,
            assumptions: stringifyJsonArray(item.assumptions),
            dedupeKey: item.dedupeKey || null,
            nodeRange: item.nodeRange || null,
            stationRange: item.stationRange || null,
            isDemo: item.isDemo ?? false,
            folderPath: item.folderPath || computeFolderPath(item),
            // Learning system: snapshot original AI values
            originalAiQuantity: item.quantity,
            originalAiName: item.name,
          })),
        });
      }

      await prisma.extraction.update({
        where: { id: extraction.id },
        data: {
          status: "completed",
          summary: finalSummary,
          rawResponse: JSON.stringify(result),
          verified: verificationApplied,
          verificationDiagnostics: verificationDiagnosticsJson,
          durationMs: Date.now() - extractionStartTime,
        },
      });

      // Separate pdfData write — this is the slow one. Wrapped in try/catch
      // so a failure here doesn't roll back the extraction completion. The
      // user still gets their items; only cached-PDF features (re-extract,
      // scale bar, region highlights) won't work without this.
      try {
        await prisma.extraction.update({
          where: { id: extraction.id },
          data: { pdfData: Buffer.from(rawBuffer) },
        });
      } catch (pdfSaveError) {
        console.warn(
          `[extract] Failed to save pdfData blob (${(rawBuffer.length / 1024 / 1024).toFixed(1)} MB). Extraction still completed. Cached-PDF features (re-extract, scale, regions) will not work for this extraction.`,
          pdfSaveError instanceof Error ? pdfSaveError.message : pdfSaveError
        );
      }

      const durationMs = Date.now() - extractionStartTime;
      const durationSec = (durationMs / 1000).toFixed(1);
      console.log(`[extract] Extraction completed in ${durationSec}s (${sanitizedItems.length} items)`);

      const response: Record<string, unknown> = {
        extractionId: extraction.id,
        status: "completed",
        summary: finalSummary,
        durationMs,
        durationFormatted: durationMs >= 60000
          ? `${Math.floor(durationMs / 60000)}m ${Math.round((durationMs % 60000) / 1000)}s`
          : `${durationSec}s`,
        counts: {
          totalItems: sanitizedItems.length,
          area: sanitizedItems.filter((i) => i.measurementType === "area")
            .length,
          count: sanitizedItems.filter((i) => i.measurementType === "count")
            .length,
          linear: sanitizedItems.filter((i) => i.measurementType === "linear")
            .length,
        },
      };

      if (sanitizedItems.length === 0) {
        response.warning =
          "No items were extracted. The PDF may not contain civil plan sheets, or try using page ranges to target civil sheets directly.";
      }

      return NextResponse.json(response);
    } catch (extractionError) {
      const errMsg =
        extractionError instanceof Error
          ? extractionError.message
          : "Unknown error during extraction";
      console.error("Extraction error:", errMsg);

      // Determine appropriate status code and user-facing message
      let statusCode = 500;
      let userMessage = `Extraction failed: ${errMsg}`;

      if (
        isPdfProcessingError(extractionError) ||
        errMsg.includes("Could not process PDF")
      ) {
        statusCode = 422;
        userMessage =
          "The PDF could not be processed by the AI. This can happen with PDFs that have " +
          "complex formatting, scanned images without OCR, or encrypted content. " +
          "Try re-exporting the PDF with simplified formatting, or select specific page ranges.";
      } else if (errMsg.includes("corrupted output")) {
        statusCode = 422;
        userMessage =
          "The PDF became corrupted during page extraction. " +
          "Try uploading the full PDF without page ranges, or re-export it from the source application.";
      } else if (
        errMsg.includes("429") ||
        errMsg.includes("RATE_LIMIT") ||
        errMsg.includes("RESOURCE_EXHAUSTED") ||
        errMsg.includes("rate limit") ||
        errMsg.includes("overloaded") ||
        errMsg.includes("high demand")
      ) {
        statusCode = 429;
        userMessage =
          "The AI provider is currently experiencing high demand. " +
          "All retry attempts were exhausted. Please wait a few minutes and try again.";
      }

      await prisma.extraction.update({
        where: { id: extraction.id },
        data: {
          status: "failed",
          errorMessage: errMsg,
          durationMs: Date.now() - extractionStartTime,
        },
      });

      return NextResponse.json(
        {
          error: userMessage,
          extractionId: extraction.id,
        },
        { status: statusCode }
      );
    }
  } catch (error) {
    console.error("Extract API error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Something went wrong",
      },
      { status: 500 }
    );
  }
}
