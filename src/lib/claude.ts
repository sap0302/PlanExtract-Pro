import Anthropic, { BadRequestError } from "@anthropic-ai/sdk";
import {
  SYSTEM_PROMPT,
  USER_PROMPT,
  EXTRACTION_TOOL,
  VERIFICATION_SYSTEM_PROMPT,
  VERIFICATION_TOOL,
  buildVerificationUserPrompt,
} from "./prompts";

// Lazy-initialize the Anthropic client to ensure environment variables are loaded
let _anthropic: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!_anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is not set. Add it to your .env file."
      );
    }
    _anthropic = new Anthropic({
      apiKey,
      maxRetries: 0, // Disable SDK's built-in short retries — we handle retries ourselves with longer backoff suited for per-minute rate limits
    });
  }
  return _anthropic;
}

export interface ExtractedItem {
  name: string;
  description?: string;
  measurementType: "area" | "count" | "linear";
  system: "water" | "storm_drain" | "wastewater" | "other";
  quantity: number;
  unit: "SQ FT" | "EA" | "FT";
  confidence: "high" | "medium" | "low";
}

export interface ExtractionResult {
  summary: string;
  items: ExtractedItem[];
}

/**
 * Retry callback type for rate limit handling.
 * Called before each retry wait so callers can update UI/DB status.
 */
export type OnRetryCallback = (
  attempt: number,
  waitSeconds: number
) => void | Promise<void>;

/**
 * Call the Claude API with automatic retry on 429 rate limit errors.
 * Uses exponential backoff starting at 60s since the rate limit is per-minute.
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
      // Robust rate limit detection: check status property (works even if instanceof fails
      // across module boundaries), then fallback to message string matching
      const errObj = error as Record<string, unknown>;
      const isRateLimit =
        errObj?.status === 429 ||
        (error instanceof Error &&
          (error.message.includes("429") ||
            error.message.includes("rate_limit") ||
            error.message.includes("rate limit")));

      if (!isRateLimit || attempt === MAX_RETRIES) {
        throw error;
      }

      // Try to extract retry-after from API response headers
      let waitSec = DEFAULT_BACKOFF_SECONDS[attempt];
      try {
        const headers = errObj?.headers as { get?: (key: string) => string | null } | undefined;
        const retryAfterMs = headers?.get?.("retry-after-ms");
        const retryAfter = headers?.get?.("retry-after");
        if (retryAfterMs) {
          const parsed = parseFloat(retryAfterMs);
          if (!isNaN(parsed) && parsed > 0) {
            waitSec = Math.ceil(parsed / 1000);
          }
        } else if (retryAfter) {
          const parsed = parseFloat(retryAfter);
          if (!isNaN(parsed) && parsed > 0) {
            waitSec = Math.ceil(parsed);
          }
        }
      } catch {
        // Ignore header parsing errors, use default backoff
      }

      // Ensure minimum 30s wait (rate limit is per-minute)
      waitSec = Math.max(30, waitSec);

      console.log(
        `Rate limited by Claude API. Waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}...`
      );

      if (onRetry) {
        await onRetry(attempt + 1, waitSec);
      }

      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
    }
  }

  // TypeScript: this line is unreachable but satisfies the return type
  throw new Error("Unexpected: exceeded retry loop");
}

/**
 * Check if an error is specifically a "Could not process PDF" 400 error
 * from the Claude API (as opposed to other 400 errors like malformed requests).
 */
export function isPdfProcessingError(error: unknown): boolean {
  // Check via SDK's typed error class
  if (error instanceof BadRequestError) {
    return (error.message || "").includes("Could not process PDF");
  }
  // Fallback: check raw status + message pattern (for cross-module boundary issues)
  const errObj = error as Record<string, unknown>;
  if (errObj?.status === 400) {
    const msg = String(errObj?.message || "");
    return msg.includes("Could not process PDF");
  }
  return false;
}

/**
 * Parse the tool_use response from Claude into an ExtractionResult.
 */
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

  // Ensure items is a valid array (Claude may omit or return non-array)
  if (!result.items || !Array.isArray(result.items)) {
    result.items = [];
  }
  if (!result.summary || typeof result.summary !== "string") {
    result.summary = "";
  }

  return result;
}

export async function extractFromPDF(
  pdfBase64: string,
  userPrompt?: string,
  onRetry?: OnRetryCallback
): Promise<ExtractionResult> {
  const model = process.env.CLAUDE_MODEL || "claude-opus-4-6";

  const response = await callWithRetry(
    () =>
      getAnthropicClient().messages.create({
        model,
        max_tokens: 16384,
        temperature: 0.2, // Low temperature for consistent, deterministic extractions
        system: SYSTEM_PROMPT,
        tools: [EXTRACTION_TOOL],
        tool_choice: { type: "tool" as const, name: "extract_inventory" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfBase64,
                },
              },
              {
                type: "text",
                text: userPrompt || USER_PROMPT,
              },
            ],
          },
        ],
      }),
    onRetry
  );

  return parseExtractionResponse(response);
}

/**
 * Process multiple PDF chunks through Claude and merge the results.
 * Used for PDFs that are too large to send in a single request.
 *
 * @param pdfChunks - Array of base64-encoded PDF chunks
 * @param chunkLabels - Human-readable labels for each chunk (e.g., "Pages 1-10")
 * @param onProgress - Optional callback for progress updates
 */
export async function extractFromPDFChunked(
  pdfChunks: string[],
  chunkLabels: string[],
  onProgress?: (chunkIndex: number, totalChunks: number, label: string) => void,
  userPrompt?: string,
  onRetry?: OnRetryCallback
): Promise<ExtractionResult> {
  const allItems: ExtractedItem[] = [];
  const summaries: string[] = [];
  const failedChunks: string[] = [];

  for (let i = 0; i < pdfChunks.length; i++) {
    const label = chunkLabels[i] || `Chunk ${i + 1}`;
    console.log(`Processing chunk ${i + 1}/${pdfChunks.length}: ${label}`);

    if (onProgress) {
      onProgress(i, pdfChunks.length, label);
    }

    try {
      const result = await extractFromPDF(pdfChunks[i], userPrompt, onRetry);

      allItems.push(...result.items);
      if (result.summary) {
        summaries.push(result.summary);
      }
    } catch (chunkError) {
      if (isPdfProcessingError(chunkError)) {
        // Skip this chunk but continue processing the rest
        console.warn(
          `[claude] Chunk ${i + 1} (${label}) failed with PDF processing error. Skipping.`
        );
        failedChunks.push(label);
        continue;
      }
      // Non-PDF errors (auth, rate limit exhausted, server errors) should still abort
      throw chunkError;
    }
  }

  // If ALL chunks failed, throw a clear error
  if (failedChunks.length === pdfChunks.length) {
    throw new Error(
      "Claude could not process any chunk of this PDF. " +
        "The file may contain unsupported features. " +
        "Try re-exporting it with flattened formatting or use page ranges to select specific sections."
    );
  }

  // Deduplicate items: merge items with same name + system + measurementType
  const mergedItems = deduplicateItems(allItems);

  // Combine summaries
  const combinedSummary =
    summaries.length === 1
      ? summaries[0]
      : summaries.length > 1
        ? summaries[0] // Use the first chunk's summary as primary (most context)
        : "";

  // Append warning about skipped chunks if any
  const warningNote =
    failedChunks.length > 0
      ? ` (Warning: ${failedChunks.length} chunk(s) could not be processed: ${failedChunks.join(", ")})`
      : "";

  return {
    summary: combinedSummary + warningNote,
    items: mergedItems,
  };
}

// ─── Two-Pass Verification ──────────────────────────────────────────────────

export interface QuantityCorrection {
  name: string;
  originalQuantity: number;
  correctedQuantity: number;
  reason: string;
}

export interface VerificationResult {
  corrections: QuantityCorrection[];
  verificationNotes: string;
}

/**
 * Parse the tool_use response from the verification call.
 */
function parseVerificationResponse(
  response: Anthropic.Message
): VerificationResult {
  const toolUseBlock = response.content.find(
    (block) => block.type === "tool_use"
  );

  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    // If Claude didn't use the tool, return empty corrections
    return { corrections: [], verificationNotes: "No verification tool response received." };
  }

  const result = toolUseBlock.input as VerificationResult;

  // Ensure corrections is a valid array
  if (!result.corrections || !Array.isArray(result.corrections)) {
    result.corrections = [];
  }
  if (!result.verificationNotes || typeof result.verificationNotes !== "string") {
    result.verificationNotes = "";
  }

  return result;
}

/**
 * Run a second-pass verification on extracted items.
 * Sends the PDF again with the extracted items and asks Claude to double-check quantities.
 */
export async function verifyExtraction(
  pdfBase64: string,
  items: ExtractedItem[],
  onRetry?: OnRetryCallback
): Promise<VerificationResult> {
  const model = process.env.CLAUDE_MODEL || "claude-opus-4-6";
  const userPrompt = buildVerificationUserPrompt(items);

  const response = await callWithRetry(
    () =>
      getAnthropicClient().messages.create({
        model,
        max_tokens: 8192,
        temperature: 0.1, // Even lower temperature for focused quantity review
        system: VERIFICATION_SYSTEM_PROMPT,
        tools: [VERIFICATION_TOOL],
        tool_choice: { type: "tool" as const, name: "verify_quantities" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: pdfBase64,
                },
              },
              {
                type: "text",
                text: userPrompt,
              },
            ],
          },
        ],
      }),
    onRetry
  );

  return parseVerificationResponse(response);
}

/**
 * Apply verification corrections to extracted items.
 * Matches corrections by exact item name.
 *
 * @returns correctedItems and count of corrections applied
 */
export function applyVerificationCorrections(
  items: ExtractedItem[],
  corrections: QuantityCorrection[]
): { correctedItems: ExtractedItem[]; correctionCount: number } {
  let correctionCount = 0;

  const correctionMap = new Map<string, QuantityCorrection>();
  for (const correction of corrections) {
    correctionMap.set(correction.name, correction);
  }

  const correctedItems = items.map((item) => {
    const correction = correctionMap.get(item.name);
    if (!correction) return item;

    // Only apply if the correction actually changes the quantity
    if (correction.correctedQuantity === item.quantity) return item;

    correctionCount++;
    const originalQty =
      item.measurementType === "count"
        ? correction.originalQuantity.toFixed(0)
        : correction.originalQuantity.toFixed(2);
    const correctedQty =
      item.measurementType === "count"
        ? correction.correctedQuantity.toFixed(0)
        : correction.correctedQuantity.toFixed(2);

    const verifyNote = `[Verified: was ${originalQty}, corrected to ${correctedQty} — ${correction.reason}]`;
    const newDescription = item.description
      ? `${item.description} ${verifyNote}`
      : verifyNote;

    return {
      ...item,
      quantity: correction.correctedQuantity,
      description: newDescription,
    };
  });

  return { correctedItems, correctionCount };
}

/**
 * Deduplicate extracted items by merging those with the same
 * name + system + measurementType, summing their quantities.
 */
function deduplicateItems(items: ExtractedItem[]): ExtractedItem[] {
  const itemMap = new Map<string, ExtractedItem>();

  for (const item of items) {
    const key = `${item.name}|${item.system}|${item.measurementType}`;

    if (itemMap.has(key)) {
      const existing = itemMap.get(key)!;
      existing.quantity += item.quantity;

      // Merge descriptions if different
      if (item.description && item.description !== existing.description) {
        existing.description = existing.description
          ? `${existing.description}; ${item.description}`
          : item.description;
      }
    } else {
      itemMap.set(key, { ...item });
    }
  }

  return Array.from(itemMap.values());
}
