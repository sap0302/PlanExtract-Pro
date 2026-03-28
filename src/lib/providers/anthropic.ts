import Anthropic, { BadRequestError } from "@anthropic-ai/sdk";
import { extractPdfText } from "../pdf-utils";
import {
  SYSTEM_PROMPT,
  USER_PROMPT,
  EXTRACTION_TOOL,
  VERIFICATION_SYSTEM_PROMPT,
  VERIFICATION_TOOL,
  buildVerificationUserPrompt,
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
 * Retry wrapper for Anthropic API calls with 429 rate limit handling.
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
      const isRateLimit =
        errObj?.status === 429 ||
        (error instanceof Error &&
          (error.message.includes("429") ||
            error.message.includes("rate_limit") ||
            error.message.includes("rate limit")));

      if (!isRateLimit || attempt === MAX_RETRIES) {
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
      config.model || process.env.CLAUDE_MODEL || "claude-sonnet-4-20250514";
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
      `[anthropic] Prompt check: EXTRACTION_RULES=${promptHasExtractionRules}, MEASURE_SECTION=${promptHasMeasureSection}, prompt length=${SYSTEM_PROMPT.length}`
    );
    // Extract text to supplement visual PDF analysis (helps with OCR-quality plans)
    const pdfText = await extractPdfText(pdfBase64);
    const textContext = pdfText.startsWith("[") ? "" : `\n\n--- Extracted Text (for reference) ---\n${pdfText}`;

    const response = await callWithRetry(
      () =>
        this.client.messages.create({
          model: this.model,
          max_tokens: 32768,
          temperature: 0.1,
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
                { type: "text", text: (userPrompt || USER_PROMPT) + textContext },
              ],
            },
          ],
        }),
      onRetry
    );
    return parseExtractionResponse(response);
  }

  async verifyExtraction(
    pdfBase64: string,
    items: ExtractedItem[],
    onRetry?: OnRetryCallback,
    customInstructions?: string | null
  ): Promise<VerificationResult> {
    const userPrompt = buildVerificationUserPrompt(items, customInstructions);
    const response = await callWithRetry(
      () =>
        this.client.messages.create({
          model: this.model,
          max_tokens: 8192,
          temperature: 0.1,
          system: VERIFICATION_SYSTEM_PROMPT,
          tools: [VERIFICATION_TOOL],
          tool_choice: {
            type: "tool" as const,
            name: "verify_quantities",
          },
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
                { type: "text", text: userPrompt },
              ],
            },
          ],
        }),
      onRetry
    );
    return parseVerificationResponse(response);
  }
}
