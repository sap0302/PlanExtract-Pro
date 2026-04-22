import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/encryption";
import { AnthropicProvider } from "@/lib/providers/anthropic";
import { applyVerificationCorrections, applyNameCorrections } from "@/lib/providers/verification-utils";
import type { ExtractedItem } from "@/lib/providers/types";

/**
 * POST /api/extractions/[id]/verify-item
 *
 * Body: { itemId: string }
 *
 * Re-verifies a single item by sending a focused verification prompt to
 * Anthropic. The AI re-reads the drawing for just this one item and returns
 * either a quantity correction, a name correction, or no change. The
 * correction (if any) is applied to the item in the database and the
 * updated item is returned.
 *
 * Only supported for extractions using the Anthropic provider. Returns 400
 * if the extraction was done with OpenAI or Gemini.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  let itemId: string;
  try {
    const body = await req.json();
    itemId = body.itemId;
    if (!itemId || typeof itemId !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid itemId in request body" },
        { status: 400 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  // Fetch the extraction with the user's API key and the target item
  const extraction = await prisma.extraction.findUnique({
    where: { id },
    select: {
      pdfData: true,
      userId: true,
      fileName: true,
      provider: true,
      user: {
        select: {
          anthropicKeyEnc: true,
          customInstructions: true,
        },
      },
    },
  });

  if (!extraction || extraction.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!extraction.pdfData) {
    return NextResponse.json(
      { error: "PDF not stored for this extraction — re-extract from the original file first." },
      { status: 400 }
    );
  }

  if (extraction.provider !== "anthropic") {
    return NextResponse.json(
      {
        error: `Focused verification is only available for Anthropic extractions. This extraction used ${extraction.provider}.`,
      },
      { status: 400 }
    );
  }

  // Load the target item and confirm it belongs to this extraction
  const item = await prisma.item.findUnique({
    where: { id: itemId },
  });
  if (!item || item.extractionId !== id) {
    return NextResponse.json(
      { error: "Item not found in this extraction" },
      { status: 404 }
    );
  }

  // Resolve the Anthropic API key (user key first, then server env fallback)
  let apiKey: string | null = null;
  if (extraction.user.anthropicKeyEnc) {
    try {
      apiKey = decrypt(extraction.user.anthropicKeyEnc);
    } catch {
      apiKey = null;
    }
  }
  if (!apiKey) {
    apiKey = process.env.ANTHROPIC_API_KEY || null;
  }
  if (!apiKey) {
    return NextResponse.json(
      { error: "No Anthropic API key configured. Add one in Settings." },
      { status: 400 }
    );
  }

  // Convert the Prisma item to the ExtractedItem shape the provider expects
  const extractedItem: ExtractedItem = {
    name: item.name,
    description: item.description ?? "",
    measurementType: item.measurementType as "area" | "count" | "linear",
    system: item.system as "water" | "storm_drain" | "wastewater" | "other",
    quantity: item.quantity,
    unit: item.unit as "SQ FT" | "EA" | "FT",
    confidence: item.confidence as "high" | "medium" | "low",
    sourcePages: item.sourcePages
      ? (JSON.parse(item.sourcePages) as number[])
      : undefined,
    sourceSheetId: item.sourceSheetId ?? undefined,
    quantityMethod:
      (item.quantityMethod as ExtractedItem["quantityMethod"]) ?? undefined,
    evidence: item.evidence ?? undefined,
    assumptions: item.assumptions
      ? (JSON.parse(item.assumptions) as string[])
      : undefined,
    dedupeKey: item.dedupeKey ?? undefined,
    nodeRange: item.nodeRange ?? undefined,
    stationRange: item.stationRange ?? undefined,
    isDemo: item.isDemo,
    folderPath: item.folderPath ?? undefined,
  };

  // Build the provider and run focused verification
  const provider = new AnthropicProvider({ apiKey });
  const pdfBase64 = Buffer.from(extraction.pdfData).toString("base64");

  try {
    console.log(
      `[verify-item] Re-verifying item ${item.id} "${item.name}" (qty=${item.quantity} ${item.unit})`
    );
    const result = await provider.verifyFocused(
      pdfBase64,
      [extractedItem],
      undefined,
      extraction.user.customInstructions
    );

    // Apply any corrections Claude returned to our 1-item list
    let correctedItems: ExtractedItem[] = [extractedItem];
    let quantityChanged = false;
    let nameChanged = false;

    if (result.corrections.length > 0) {
      const applied = applyVerificationCorrections(
        correctedItems,
        result.corrections
      );
      if (applied.correctionCount > 0) {
        correctedItems = applied.correctedItems;
        quantityChanged = true;
      }
    }

    if (result.nameCorrections && result.nameCorrections.length > 0) {
      const applied = applyNameCorrections(
        correctedItems,
        result.nameCorrections
      );
      if (applied.renameCount > 0) {
        correctedItems = applied.renamedItems;
        nameChanged = true;
      }
    }

    const updated = correctedItems[0];

    // Persist changes to the DB if anything was corrected
    if (quantityChanged || nameChanged) {
      await prisma.item.update({
        where: { id: itemId },
        data: {
          ...(quantityChanged && { quantity: updated.quantity }),
          ...(nameChanged && { name: updated.name }),
          // Mark that this item has been manually re-verified
          evidence:
            (item.evidence ?? "") +
            (item.evidence ? "\n\n" : "") +
            `[Re-verified ${new Date().toISOString()}] ${
              quantityChanged
                ? `Quantity changed ${item.quantity.toFixed(2)} → ${updated.quantity.toFixed(2)}. `
                : ""
            }${
              nameChanged ? `Name changed "${item.name}" → "${updated.name}". ` : ""
            }${result.verificationNotes ? `Notes: ${result.verificationNotes}` : ""}`.trim(),
        },
      });
    }

    // Fetch the final DB row to return (with all computed/fresh fields)
    const freshItem = await prisma.item.findUnique({ where: { id: itemId } });

    return NextResponse.json({
      item: freshItem,
      changed: quantityChanged || nameChanged,
      quantityChanged,
      nameChanged,
      previousQuantity: quantityChanged ? item.quantity : null,
      previousName: nameChanged ? item.name : null,
      verificationNotes: result.verificationNotes ?? "",
    });
  } catch (err) {
    console.error("[verify-item] Focused verification failed:", err);
    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Focused verification failed",
      },
      { status: 500 }
    );
  }
}
