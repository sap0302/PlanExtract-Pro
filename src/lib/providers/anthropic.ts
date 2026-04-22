import Anthropic, { BadRequestError } from "@anthropic-ai/sdk";
import { extractPdfText, extractTextWithPositions, renderPdfToImages } from "../pdf-utils";
import {
  SYSTEM_PROMPT,
  USER_PROMPT,
  EXTRACTION_TOOL,
  VERIFICATION_SYSTEM_PROMPT,
  VERIFICATION_TOOL,
  buildVerificationUserPrompt,
  buildFocusedVerificationUserPrompt,
} from "../prompts";
import type {
  AIProvider,
  ProviderConfig,
  ExtractionResult,
  ExtractedItem,
  VerificationResult,
  OnRetryCallback,
} from "./types";

/**
 * Combined system prompt covering BOTH extraction and verification.
 *
 * Why combined: Anthropic's prompt cache keys on the exact tools+system+messages
 * prefix. By using the same system prompt + same tools list for both the
 * extraction and verification calls, the verification call (which sends the
 * SAME PDF images) can hit the cache written by the extraction call and pay
 * ~10% of the input-token cost for the shared prefix. tool_choice steers
 * which tool Claude invokes; it is NOT part of the cached prefix.
 *
 * The combined prompt is roughly [extraction rules] + [verification rules].
 * Per-call user prompts clarify which task is active.
 */
const COMBINED_SYSTEM_PROMPT =
  SYSTEM_PROMPT +
  "\n\n---\n\n## VERIFICATION MODE (only when the verify_quantities tool is selected)\n\n" +
  VERIFICATION_SYSTEM_PROMPT;

/**
 * Both tools sent on every call. tool_choice selects which one Claude uses.
 * Order matters for caching — keep this exact order in every call.
 */
const COMBINED_TOOLS = [EXTRACTION_TOOL, VERIFICATION_TOOL] as const;

/**
 * System prompt as a TextBlockParam array with an ephemeral cache breakpoint.
 * This caches the [tools + system] prefix across all calls in a 5-minute window.
 */
const CACHED_SYSTEM_PARAM: Anthropic.TextBlockParam[] = [
  {
    type: "text",
    text: COMBINED_SYSTEM_PROMPT,
    cache_control: { type: "ephemeral" },
  },
];

/**
 * Retry wrapper for Anthropic API calls.
 * Handles 429 (rate limit), 529 (overloaded), and 503 (service unavailable).
 */
async function callWithRetry(
  apiCall: () => Promise<Anthropic.Message>,
  onRetry?: OnRetryCallback
): Promise<Anthropic.Message> {
  const MAX_RETRIES = 3;
  const DEFAULT_BACKOFF_SECONDS = [60, 90, 120];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await apiCall();
    } catch (error: unknown) {
      const errObj = error as Record<string, unknown>;
      const status = errObj?.status;
      const msg = error instanceof Error ? error.message.toLowerCase() : "";

      // Retry on transient Anthropic errors:
      //   429 = rate limit, 529 = overloaded, 503 = service unavailable
      const isRetryable =
        status === 429 ||
        status === 529 ||
        status === 503 ||
        msg.includes("429") ||
        msg.includes("529") ||
        msg.includes("503") ||
        msg.includes("rate_limit") ||
        msg.includes("rate limit") ||
        msg.includes("overloaded");

      if (!isRetryable || attempt === MAX_RETRIES) {
        throw error;
      }

      let waitSec = DEFAULT_BACKOFF_SECONDS[attempt];
      try {
        const headers = errObj?.headers as
          | { get?: (key: string) => string | null }
          | undefined;
        const retryAfterMs = headers?.get?.("retry-after-ms");
        const retryAfter = headers?.get?.("retry-after");
        if (retryAfterMs) {
          const parsed = parseFloat(retryAfterMs);
          if (!isNaN(parsed) && parsed > 0) waitSec = Math.ceil(parsed / 1000);
        } else if (retryAfter) {
          const parsed = parseFloat(retryAfter);
          if (!isNaN(parsed) && parsed > 0) waitSec = Math.ceil(parsed);
        }
      } catch {
        // Use default backoff
      }

      waitSec = Math.max(30, waitSec);
      console.log(
        `Rate limited by Claude API. Waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}...`
      );

      if (onRetry) await onRetry(attempt + 1, waitSec);
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
    }
  }
  throw new Error("Unexpected: exceeded retry loop");
}

function parseExtractionResponse(
  response: Anthropic.Message
): ExtractionResult {
  const toolUseBlock = response.content.find(
    (block) => block.type === "tool_use"
  );
  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    throw new Error("Claude did not return structured extraction data");
  }
  const result = toolUseBlock.input as ExtractionResult;
  if (!result.items || !Array.isArray(result.items)) result.items = [];
  if (!result.summary || typeof result.summary !== "string")
    result.summary = "";
  return result;
}

function parseVerificationResponse(
  response: Anthropic.Message
): VerificationResult {
  const toolUseBlock = response.content.find(
    (block) => block.type === "tool_use"
  );
  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    return {
      corrections: [],
      additions: [],
      nameCorrections: [],
      verificationNotes: "No verification tool response received.",
    };
  }
  const result = toolUseBlock.input as VerificationResult;
  if (!result.corrections || !Array.isArray(result.corrections))
    result.corrections = [];
  if (!result.additions || !Array.isArray(result.additions))
    result.additions = [];
  if (!result.nameCorrections || !Array.isArray(result.nameCorrections))
    result.nameCorrections = [];
  if (!result.verificationNotes || typeof result.verificationNotes !== "string")
    result.verificationNotes = "";
  return result;
}

/**
 * Check if an error is a "Could not process PDF" 400 error from Claude.
 */
export function isPdfProcessingError(error: unknown): boolean {
  if (error instanceof BadRequestError) {
    return (error.message || "").includes("Could not process PDF");
  }
  const errObj = error as Record<string, unknown>;
  if (errObj?.status === 400) {
    return String(errObj?.message || "").includes("Could not process PDF");
  }
  return false;
}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic" as const;
  private client: Anthropic;
  private model: string;

  constructor(config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      maxRetries: 0,
      timeout: 20 * 60 * 1000, // 20 minutes — large PDFs can take >10min per chunk
    });
    this.model =
      config.model || process.env.CLAUDE_MODEL || "claude-opus-4-6";
  }

  /**
   * Build message content from a PDF, either as high-DPI images or as native document.
   * High-DPI images produce much better text legibility for engineering drawings.
   *
   * The LAST block (last image, or the single document block) is marked with
   * cache_control: { type: "ephemeral" } so that subsequent calls sending the
   * SAME PDF bytes (e.g. the verification pass against the same chunk) get a
   * cache hit on the entire [tools + system + images] prefix and pay ~10% of
   * the input-token cost for it.
   */
  private async buildPdfContent(
    pdfBase64: string
  ): Promise<Anthropic.ContentBlockParam[]> {
    const useHighDpi = process.env.HIGH_DPI_RENDER !== "false"; // default: enabled

    if (useHighDpi) {
      try {
        const pdfBuffer = Buffer.from(pdfBase64, "base64");
        const scale = parseFloat(process.env.PDF_RENDER_SCALE || "2.5"); // 2.5x = ~180 DPI
        const imageBuffers = await renderPdfToImages(pdfBuffer, scale);
        const totalBytes = imageBuffers.reduce((s, b) => s + b.length, 0);
        console.log(
          `[anthropic] Rendered ${imageBuffers.length} PDF pages at ${scale}x (~${Math.round(scale * 72)} DPI) as JPEG — total ${(totalBytes / 1024 / 1024).toFixed(2)} MB`
        );

        // Anthropic supports max 100 images per request
        if (imageBuffers.length > 100) {
          console.warn(
            `[anthropic] PDF has ${imageBuffers.length} pages, exceeds 100-image limit. Falling back to document mode.`
          );
        } else {
          // renderPdfToImages returns JPEG buffers (at quality 92) sized to
          // fit Anthropic's 5 MB per-image vision limit.
          const blocks: Anthropic.ImageBlockParam[] = imageBuffers.map(
            (buf) => ({
              type: "image" as const,
              source: {
                type: "base64" as const,
                media_type: "image/jpeg" as const,
                data: buf.toString("base64"),
              },
            })
          );
          // Mark the last image as a cache breakpoint. The cache key is the
          // exact prefix (tools + system + all preceding blocks + this block),
          // so verification calls on the same chunk hit it.
          if (blocks.length > 0) {
            blocks[blocks.length - 1] = {
              ...blocks[blocks.length - 1],
              cache_control: { type: "ephemeral" },
            };
          }
          return blocks;
        }
      } catch (err) {
        console.warn(
          `[anthropic] High-DPI rendering failed, falling back to document mode:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Fallback: native document mode. Also cached so verification can reuse it.
    return [
      {
        type: "document" as const,
        source: {
          type: "base64" as const,
          media_type: "application/pdf" as const,
          data: pdfBase64,
        },
        cache_control: { type: "ephemeral" },
      },
    ];
  }

  /**
   * Log cache usage from an Anthropic response so we can verify the
   * extraction→verification prompt-cache hits are actually happening.
   */
  private logCacheUsage(label: string, response: Anthropic.Message): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const usage = (response as any).usage ?? {};
    const write = Number(usage.cache_creation_input_tokens ?? 0);
    const read = Number(usage.cache_read_input_tokens ?? 0);
    const fresh = Number(usage.input_tokens ?? 0);
    const output = Number(usage.output_tokens ?? 0);
    console.log(
      `[anthropic] ${label} tokens — fresh:${fresh} cacheWrite:${write} cacheRead:${read} output:${output}`
    );
  }

  async extractFromPDF(
    pdfBase64: string,
    userPrompt?: string,
    onRetry?: OnRetryCallback
  ): Promise<ExtractionResult> {
    // Debug: verify prompt version loaded
    const promptHasExtractionRules = SYSTEM_PROMPT.includes("ZERO ITEMS IS ALMOST NEVER CORRECT");
    const promptHasMeasureSection = SYSTEM_PROMPT.includes("HOW TO MEASURE QUANTITIES");
    console.log(
      `[anthropic] Prompt check: EXTRACTION_RULES=${promptHasExtractionRules}, MEASURE_SECTION=${promptHasMeasureSection}, prompt length=${SYSTEM_PROMPT.length}, combined=${COMBINED_SYSTEM_PROMPT.length}`
    );
    // Extract text to supplement visual PDF analysis (helps with OCR-quality plans)
    const pdfText = await extractPdfText(pdfBase64);
    const textContext = pdfText.startsWith("[") ? "" : `\n\n--- Extracted Text (for reference) ---\n${pdfText}`;

    // Extract positioned text items from the PDF's text layer using pdfjs-dist.
    // This gives Claude explicit (x,y) coordinates + font sizes for every text
    // span the PDF preserves as real text (not outlined geometry).
    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const positionedText = await extractTextWithPositions(pdfBuffer);
    const positionedTextContext = positionedText
      ? `\n\n--- PDF Text Layer (with coordinates — use to confirm small callouts) ---\n${positionedText}`
      : "";

    const pdfContent = await this.buildPdfContent(pdfBase64);

    const response = await callWithRetry(
      () =>
        this.client.messages.create({
          model: this.model,
          max_tokens: 32768,
          temperature: 0.1,
          // Cached system + combined tools: verification pass can hit this prefix.
          system: CACHED_SYSTEM_PARAM,
          tools: [...COMBINED_TOOLS],
          tool_choice: { type: "tool" as const, name: "extract_inventory" },
          messages: [
            {
              role: "user",
              content: [
                ...pdfContent,
                { type: "text", text: (userPrompt || USER_PROMPT) + textContext + positionedTextContext },
              ],
            },
          ],
        }),
      onRetry
    );
    this.logCacheUsage("extract", response);
    return parseExtractionResponse(response);
  }

  async verifyExtraction(
    pdfBase64: string,
    items: ExtractedItem[],
    onRetry?: OnRetryCallback,
    customInstructions?: string | null
  ): Promise<VerificationResult> {
    const userPrompt = buildVerificationUserPrompt(items, customInstructions);
    const pdfContent = await this.buildPdfContent(pdfBase64);
    const response = await callWithRetry(
      () =>
        this.client.messages.create({
          model: this.model,
          max_tokens: 8192,
          temperature: 0.1,
          // Same system + tools as extractFromPDF so this call hits the
          // extraction pass's cached [tools + system + images] prefix.
          system: CACHED_SYSTEM_PARAM,
          tools: [...COMBINED_TOOLS],
          tool_choice: {
            type: "tool" as const,
            name: "verify_quantities",
          },
          messages: [
            {
              role: "user",
              content: [
                ...pdfContent,
                { type: "text", text: userPrompt },
              ],
            },
          ],
        }),
      onRetry
    );
    this.logCacheUsage("verify ", response);
    return parseVerificationResponse(response);
  }

  /**
   * Focused re-verification of a small set of high-value items. Uses the
   * buildFocusedVerificationUserPrompt builder to tell Claude to recompute
   * ONLY the quantities for the listed items — no additions, no scope
   * checks, no connectivity flags. The same VERIFICATION_TOOL output schema
   * is used so corrections flow through the same applyVerificationCorrections
   * pipeline as the normal verification pass.
   *
   * Intended for:
   *   - Automatic post-extraction sweep of the 6-10 highest-leverage items
   *     (longest pipes, SSMH list, rip rap / pilot flume, low-confidence items)
   *   - User-triggered "Verify this item" button in the inventory UI
   *
   * This method is NOT on the AIProvider interface — callers should check
   * `provider.name === "anthropic"` and cast before calling. OpenAI and
   * Gemini providers don't implement focused verification yet.
   */
  async verifyFocused(
    pdfBase64: string,
    items: ExtractedItem[],
    onRetry?: OnRetryCallback,
    customInstructions?: string | null
  ): Promise<VerificationResult> {
    const userPrompt = buildFocusedVerificationUserPrompt(
      items,
      customInstructions
    );
    const pdfContent = await this.buildPdfContent(pdfBase64);
    const response = await callWithRetry(
      () =>
        this.client.messages.create({
          model: this.model,
          max_tokens: 8192,
          temperature: 0.1,
          // Same cached system + tools as extractFromPDF / verifyExtraction
          // so this call hits the cached [tools + system + images] prefix
          // within the 5-minute ephemeral window.
          system: CACHED_SYSTEM_PARAM,
          tools: [...COMBINED_TOOLS],
          tool_choice: {
            type: "tool" as const,
            name: "verify_quantities",
          },
          messages: [
            {
              role: "user",
              content: [
                ...pdfContent,
                { type: "text", text: userPrompt },
              ],
            },
          ],
        }),
      onRetry
    );
    this.logCacheUsage("focused", response);
    return parseVerificationResponse(response);
  }

  /**
   * High-DPI re-read of specific pages for small fittings that native PDF
   * mode's ~72 DPI rendering can't resolve (HDPE wyes, small bends, etc.).
   *
   * Unlike verifyFocused() which sends the full PDF and asks about specific
   * items, this method sends PRE-RENDERED high-DPI JPEG images of just 1-3
   * pages and asks Claude to extract ALL fittings visible on those pages.
   *
   * The caller is responsible for rendering the pages at 300 DPI and passing
   * the JPEG buffers. This method builds image content blocks from those
   * buffers (not from a PDF) and sends a focused extraction prompt.
   *
   * Returns additions + corrections in the same VerificationResult shape so
   * the results flow through the existing applyVerificationCorrections pipeline.
   *
   * Cost: ~$0.15-0.30 per page at Opus pricing (one high-DPI image per page).
   */
  async reReadPagesHighDpi(
    imageBuffers: Buffer[],
    pageNumbers: number[],
    existingItems: ExtractedItem[],
    onRetry?: OnRetryCallback
  ): Promise<VerificationResult> {
    // Build image content blocks from the pre-rendered JPEG buffers
    const imageBlocks: Anthropic.ImageBlockParam[] = imageBuffers.map(
      (buf) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/jpeg" as const,
          data: buf.toString("base64"),
        },
      })
    );

    // Cache breakpoint on the last image
    if (imageBlocks.length > 0) {
      imageBlocks[imageBlocks.length - 1] = {
        ...imageBlocks[imageBlocks.length - 1],
        cache_control: { type: "ephemeral" },
      };
    }

    // Build a focused prompt for reading small fittings
    const pageList = pageNumbers.join(", ");
    const existingFittings = existingItems
      .filter((it) => it.measurementType === "count")
      .map((it) => `${it.quantity} × ${it.name}`)
      .join(", ");

    const userPrompt = `You are re-reading ${imageBuffers.length} page(s) (pages ${pageList}) at HIGH RESOLUTION (300 DPI) to find small fittings that were missed at lower resolution.

These pages are STORM DRAIN PLAN VIEW sheets. Look carefully for ALL fitting callouts — especially:

1. **HDPE WYE connections** with TWO sizes: "1-24"X18" WYE", "1-21"X15" WYE", "1-30"X15" WYE", "1-36"X21" WYE", "1-18"X18" WYE". These are the MOST commonly missed items. Read EVERY callout box on the page.

2. **HDPE BEND fittings** with angle: "1-15" 45° BEND", "1-18" 45° BEND", "6" HDPE 90 BEND". Look at every pipe direction change.

3. **JUNCTION BOXES** with dimensions: "4X4 JUNCTION BOX", "5X5 JUNCTION BOX", "6X6 JUNCTION BOX". Look for square symbols at pipe intersections.

4. **CURB INLETS** with width: "5' CURB INLET", "10' CURB INLET", "15' CURB INLET". Read the width label next to each inlet symbol.

5. **HEADWALLS** with size and type: "30" TXDOT HEADWALL", "48" TXDOT HEADWALL", "CAST IN PLACE 36" TXDOT HEADWALL", "15" TYPE C HEADWALL".

6. **HDPE PLUGS** with size: "18" HDPE PLUG", "21" HDPE PLUG", "24" HDPE PLUG".

The current extraction already found these fittings: ${existingFittings || "none yet"}.

Return:
- **additions**: ANY fittings you can see on these pages that are NOT in the existing list above. Include the exact size pair for wyes (e.g., "24X18 HDPE WYE SD"), the exact angle for bends, and the exact size for junction boxes, inlets, headwalls, and plugs.
- **corrections**: If any existing item has the wrong quantity based on what you see on these pages, correct it.
- **nameCorrections**: If any existing item has a wrong size or type, fix it.
- Leave connectivityIssues, scopeChecks, topUncertainties, dedupFlags empty.

Read EVERY callout on the page. Small text in callout boxes is your primary target — that's why these pages were re-rendered at high resolution.`;

    const response = await callWithRetry(
      () =>
        this.client.messages.create({
          model: this.model,
          max_tokens: 8192,
          temperature: 0.1,
          system: CACHED_SYSTEM_PARAM,
          tools: [...COMBINED_TOOLS],
          tool_choice: {
            type: "tool" as const,
            name: "verify_quantities",
          },
          messages: [
            {
              role: "user",
              content: [
                ...imageBlocks,
                { type: "text", text: userPrompt },
              ],
            },
          ],
        }),
      onRetry
    );
    this.logCacheUsage("hiDPI ", response);
    return parseVerificationResponse(response);
  }
}
