import { GoogleGenerativeAI, type GenerateContentResult } from "@google/generative-ai";
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
 * Convert Anthropic tool schema to Gemini's responseSchema format.
 * Gemini uses OpenAPI 3.0 subset — strip descriptions, keep types/enums/required.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toGeminiSchema(schema: Record<string, unknown>): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = {};
  if (schema.type) result.type = (schema.type as string).toUpperCase();
  if (schema.enum) result.enum = schema.enum;
  if (schema.description) result.description = schema.description;
  if (schema.required) result.required = schema.required;

  if (schema.properties) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result.properties = {} as Record<string, any>;
    for (const [key, val] of Object.entries(
      schema.properties as Record<string, Record<string, unknown>>
    )) {
      result.properties[key] = toGeminiSchema(val);
    }
  }

  if (schema.items) {
    result.items = toGeminiSchema(
      schema.items as Record<string, unknown>
    );
  }

  return result;
}

/**
 * Attempt to repair truncated JSON by closing open brackets/braces.
 * Returns the parsed object if repair succeeds, null if not salvageable.
 */
function tryRepairTruncatedJson(text: string): unknown | null {
  // First try parsing as-is
  try {
    return JSON.parse(text);
  } catch {
    // Continue to repair attempts
  }

  // Remove any trailing incomplete string (cut mid-value)
  let cleaned = text.trimEnd();

  // Remove trailing comma if present
  cleaned = cleaned.replace(/,\s*$/, "");

  // If it ends with a partial string value (no closing quote), remove it
  // e.g., `"name": "some truncated str` → remove the partial key-value
  const lastCompleteComma = cleaned.lastIndexOf(",");
  const lastOpenBrace = cleaned.lastIndexOf("{");
  const lastOpenBracket = cleaned.lastIndexOf("[");

  // Try progressively closing open brackets/braces
  const openBraces = (cleaned.match(/{/g) || []).length;
  const closeBraces = (cleaned.match(/}/g) || []).length;
  const openBrackets = (cleaned.match(/\[/g) || []).length;
  const closeBrackets = (cleaned.match(/]/g) || []).length;

  let suffix = "";
  // Close arrays first, then objects
  for (let i = 0; i < openBrackets - closeBrackets; i++) suffix += "]";
  for (let i = 0; i < openBraces - closeBraces; i++) suffix += "}";

  // Try with closing characters appended
  try {
    return JSON.parse(cleaned + suffix);
  } catch {
    // Try removing the last partial element before closing
  }

  // Try trimming back to last complete comma and then closing
  if (lastCompleteComma > Math.max(lastOpenBrace, lastOpenBracket)) {
    const trimmed = cleaned.substring(0, lastCompleteComma);
    const ob = (trimmed.match(/{/g) || []).length;
    const cb = (trimmed.match(/}/g) || []).length;
    const oB = (trimmed.match(/\[/g) || []).length;
    const cB = (trimmed.match(/]/g) || []).length;

    let s = "";
    for (let i = 0; i < oB - cB; i++) s += "]";
    for (let i = 0; i < ob - cb; i++) s += "}";

    try {
      return JSON.parse(trimmed + s);
    } catch {
      // Not salvageable
    }
  }

  return null;
}

/**
 * Get the finish reason from a Gemini response.
 */
function getFinishReason(response: GenerateContentResult): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates = (response.response as any).candidates;
  if (candidates && candidates[0]) {
    return candidates[0].finishReason;
  }
  return undefined;
}

/**
 * Retry wrapper for Gemini API calls.
 */
async function callWithRetry(
  apiCall: () => Promise<GenerateContentResult>,
  onRetry?: OnRetryCallback
): Promise<GenerateContentResult> {
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
            error.message.includes("RATE_LIMIT") ||
            error.message.includes("RESOURCE_EXHAUSTED")));

      if (!isRateLimit || attempt === MAX_RETRIES) throw error;

      const waitSec = DEFAULT_BACKOFF_SECONDS[attempt];
      console.log(
        `Rate limited by Gemini API. Waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}...`
      );
      if (onRetry) await onRetry(attempt + 1, waitSec);
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
    }
  }
  throw new Error("Unexpected: exceeded retry loop");
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini" as const;
  private genAI: GoogleGenerativeAI;
  private modelName: string;

  constructor(config: ProviderConfig) {
    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.modelName = config.model || "gemini-2.5-pro";
  }

  async extractFromPDF(
    pdfBase64: string,
    userPrompt?: string,
    onRetry?: OnRetryCallback
  ): Promise<ExtractionResult> {
    const geminiSchema = toGeminiSchema(EXTRACTION_TOOL.input_schema);

    // Gemini 2.5 Flash is a thinking model — thinking tokens count against
    // maxOutputTokens. Cap thinking budget to leave room for JSON output.
    // The SDK types don't include thinkingConfig yet, so we use a type assertion.
    const generationConfig = {
      temperature: 0.1,
      maxOutputTokens: 65536,
      responseMimeType: "application/json",
      responseSchema: geminiSchema,
      // Cap thinking to 8K tokens, leaving ~57K for actual JSON output
      thinkingConfig: { thinkingBudget: 8192 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      systemInstruction: SYSTEM_PROMPT,
      generationConfig,
    });

    // Extract text to supplement visual PDF analysis (helps with OCR-quality plans)
    const pdfText = await extractPdfText(pdfBase64);
    const textContext = pdfText.startsWith("[") ? "" : `\n\n--- Extracted Text (for reference) ---\n${pdfText}`;

    const response = await callWithRetry(
      () =>
        model.generateContent({
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType: "application/pdf",
                    data: pdfBase64,
                  },
                },
                { text: (userPrompt || USER_PROMPT) + textContext },
              ],
            },
          ],
        }),
      onRetry
    );

    const finishReason = getFinishReason(response);
    if (finishReason && finishReason !== "STOP") {
      console.warn(
        `Gemini extraction finished with reason: ${finishReason} (expected STOP)`
      );
    }

    const text = response.response.text();
    if (!text) {
      throw new Error("Gemini returned an empty response");
    }

    let result: ExtractionResult;
    try {
      result = JSON.parse(text) as ExtractionResult;
    } catch (parseError) {
      console.error(
        `Gemini JSON parse failed (${text.length} chars, finishReason: ${finishReason}). Attempting repair...`
      );

      // Attempt to repair truncated JSON
      const repaired = tryRepairTruncatedJson(text);
      if (repaired && typeof repaired === "object") {
        console.log(
          `Successfully repaired truncated Gemini JSON response`
        );
        result = repaired as ExtractionResult;
      } else {
        console.error(`JSON repair failed. First 300 chars: ${text.slice(0, 300)}`);
        throw new Error(
          `Gemini returned invalid JSON (${text.length} chars, finishReason: ${finishReason}). ` +
            `The response was truncated and could not be repaired. Try a smaller PDF or fewer pages.`
        );
      }
    }
    if (!result.items || !Array.isArray(result.items)) result.items = [];
    if (!result.summary || typeof result.summary !== "string")
      result.summary = "";
    return result;
  }

  async verifyExtraction(
    pdfBase64: string,
    items: ExtractedItem[],
    onRetry?: OnRetryCallback,
    customInstructions?: string | null
  ): Promise<VerificationResult> {
    const verificationPrompt = buildVerificationUserPrompt(items, customInstructions);
    const geminiSchema = toGeminiSchema(VERIFICATION_TOOL.input_schema);

    const generationConfig = {
      temperature: 0.1,
      maxOutputTokens: 49152,
      responseMimeType: "application/json",
      responseSchema: geminiSchema,
      thinkingConfig: { thinkingBudget: 4096 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const model = this.genAI.getGenerativeModel({
      model: this.modelName,
      systemInstruction: VERIFICATION_SYSTEM_PROMPT,
      generationConfig,
    });

    const response = await callWithRetry(
      () =>
        model.generateContent({
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType: "application/pdf",
                    data: pdfBase64,
                  },
                },
                { text: verificationPrompt },
              ],
            },
          ],
        }),
      onRetry
    );

    const finishReason = getFinishReason(response);
    if (finishReason && finishReason !== "STOP") {
      console.warn(
        `Gemini verification finished with reason: ${finishReason} (expected STOP)`
      );
    }

    const text = response.response.text();
    if (!text) {
      return {
        corrections: [],
        additions: [],
        nameCorrections: [],
        verificationNotes: `Gemini returned an empty response (finishReason: ${finishReason}).`,
      };
    }

    let result: VerificationResult;
    try {
      result = JSON.parse(text) as VerificationResult;
    } catch (parseError) {
      console.error(
        `Gemini verification JSON parse failed (${text.length} chars, finishReason: ${finishReason}). Attempting repair...`
      );

      const repaired = tryRepairTruncatedJson(text);
      if (repaired && typeof repaired === "object") {
        console.log(`Successfully repaired truncated Gemini verification JSON`);
        result = repaired as VerificationResult;
      } else {
        return {
          corrections: [],
          additions: [],
          nameCorrections: [],
          verificationNotes: `Verification response was truncated (${text.length} chars, finishReason: ${finishReason}) and could not be repaired.`,
        };
      }
    }
    if (!result.corrections || !Array.isArray(result.corrections))
      result.corrections = [];
    if (!result.additions || !Array.isArray(result.additions))
      result.additions = [];
    if (!result.nameCorrections || !Array.isArray(result.nameCorrections))
      result.nameCorrections = [];
    if (!result.verificationNotes) result.verificationNotes = "";
    return result;
  }
}
