import OpenAI from "openai";
import { extractPdfText, extractTextWithPositions } from "../pdf-utils";
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
 * Convert Anthropic tool input_schema to OpenAI JSON Schema format.
 * - Adds additionalProperties: false at each object level for strict mode.
 * - OpenAI strict mode requires ALL properties in `required`. Properties
 *   NOT in the original `required` array are made nullable so the model
 *   can return `null` for optional fields without failing validation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toStrictJsonSchema(schema: Record<string, unknown>): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = { ...schema };
  if (result.type === "object") {
    result.additionalProperties = false;
    if (result.properties) {
      const originalRequired = new Set<string>(
        Array.isArray(result.required) ? result.required : []
      );
      const allKeys = Object.keys(result.properties);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const newProps: Record<string, any> = {};
      for (const [key, val] of Object.entries(result.properties)) {
        let converted = toStrictJsonSchema(val as Record<string, unknown>);

        // If the field is NOT in the original required list, make it nullable
        if (!originalRequired.has(key)) {
          converted = makeNullable(converted);
        }

        newProps[key] = converted;
      }
      result.properties = newProps;

      // Strict mode: ALL properties must be in required
      result.required = allKeys;
    }
  }
  if (result.type === "array" && result.items) {
    result.items = toStrictJsonSchema(result.items as Record<string, unknown>);
  }
  return result;
}

/**
 * Make a JSON Schema property nullable for OpenAI strict mode.
 * Converts `"type": "string"` → `"type": ["string", "null"]`
 * and `"type": "array"` → wraps with anyOf.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeNullable(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;

  // Already nullable
  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return schema;
  }

  // For simple types (string, number, boolean), make a union type
  if (typeof schema.type === "string" && schema.type !== "object" && schema.type !== "array") {
    return { ...schema, type: [schema.type, "null"] };
  }

  // For arrays and objects, use anyOf with null
  if (schema.type === "array" || schema.type === "object") {
    return {
      anyOf: [schema, { type: "null" }],
    };
  }

  return schema;
}

/**
 * Attempt to repair truncated JSON (e.g., from hitting max_completion_tokens).
 * Closes unclosed brackets/braces to salvage partial results.
 */
function tryRepairTruncatedJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    // Continue to repair
  }

  let cleaned = text.trimEnd();
  cleaned = cleaned.replace(/,\s*$/, "");

  const lastCompleteComma = cleaned.lastIndexOf(",");
  const lastOpenBrace = cleaned.lastIndexOf("{");
  const lastOpenBracket = cleaned.lastIndexOf("[");

  // Try closing unclosed brackets/braces
  const openBraces = (cleaned.match(/{/g) || []).length;
  const closeBraces = (cleaned.match(/}/g) || []).length;
  const openBrackets = (cleaned.match(/\[/g) || []).length;
  const closeBrackets = (cleaned.match(/]/g) || []).length;

  let suffix = "";
  for (let i = 0; i < openBrackets - closeBrackets; i++) suffix += "]";
  for (let i = 0; i < openBraces - closeBraces; i++) suffix += "}";

  try {
    return JSON.parse(cleaned + suffix);
  } catch {
    // Try trimming to last complete element
  }

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
 * Retry wrapper for OpenAI API calls.
 * Handles 429 (rate limit), 503 (service unavailable), and 529 (overloaded).
 */
async function callWithRetry(
  apiCall: () => Promise<OpenAI.Chat.Completions.ChatCompletion>,
  onRetry?: OnRetryCallback
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const MAX_RETRIES = 3;
  const DEFAULT_BACKOFF_SECONDS = [60, 90, 120];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await apiCall();
    } catch (error: unknown) {
      const errObj = error as Record<string, unknown>;
      const status = errObj?.status;
      const msg = error instanceof Error ? error.message.toLowerCase() : "";

      const isRetryable =
        status === 429 ||
        status === 503 ||
        status === 529 ||
        msg.includes("429") ||
        msg.includes("503") ||
        msg.includes("rate_limit") ||
        msg.includes("rate limit") ||
        msg.includes("overloaded") ||
        msg.includes("server_error");

      if (!isRetryable || attempt === MAX_RETRIES) throw error;

      const waitSec = DEFAULT_BACKOFF_SECONDS[attempt];
      console.log(
        `[openai] ${status || "error"}: ${msg.slice(0, 80)}. Waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}...`
      );
      if (onRetry) await onRetry(attempt + 1, waitSec);
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
    }
  }
  throw new Error("Unexpected: exceeded retry loop");
}


export class OpenAIProvider implements AIProvider {
  readonly name = "openai" as const;
  private client: OpenAI;
  private model: string;

  constructor(config: ProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      timeout: 20 * 60 * 1000, // 20 minutes — large PDFs can take >10min per chunk
    });
    this.model = config.model || "gpt-5.4";
  }

  async extractFromPDF(
    pdfBase64: string,
    userPrompt?: string,
    onRetry?: OnRetryCallback
  ): Promise<ExtractionResult> {
    const pdfContext = await extractPdfText(pdfBase64);
    const extractionSchema = toStrictJsonSchema(EXTRACTION_TOOL.input_schema);

    // Extract positioned text from the PDF text layer (pdfjs-dist)
    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const positionedText = await extractTextWithPositions(pdfBuffer);
    const positionedTextContext = positionedText
      ? `\n\n--- PDF Text Layer (with coordinates — use to confirm small callouts) ---\n${positionedText}`
      : "";

    const response = await callWithRetry(
      () =>
        this.client.chat.completions.create({
          model: this.model,
          max_completion_tokens: 65536,
          temperature: 0.1,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "extract_inventory",
              schema: extractionSchema,
              strict: true,
            },
          },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "file",
                  file: {
                    filename: "plan.pdf",
                    file_data: `data:application/pdf;base64,${pdfBase64}`,
                  },
                },
                {
                  type: "text",
                  text: `${pdfContext}${positionedTextContext}\n\n${userPrompt || USER_PROMPT}`,
                },
              ],
            },
          ],
        }),
      onRetry
    );

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("OpenAI returned an empty response");
    }

    // Check for truncation (finish_reason !== "stop")
    const finishReason = response.choices[0]?.finish_reason;
    if (finishReason === "length") {
      console.warn(
        `[openai] Response truncated (finish_reason=length, ${content.length} chars). Attempting JSON repair...`
      );
    }

    let result: ExtractionResult;
    try {
      result = JSON.parse(content) as ExtractionResult;
    } catch {
      const repaired = tryRepairTruncatedJson(content);
      if (repaired && typeof repaired === "object") {
        console.warn(
          `[openai] Repaired truncated JSON (${content.length} chars)`
        );
        result = repaired as ExtractionResult;
      } else {
        throw new Error(
          `OpenAI returned invalid JSON (${content.length} chars, finish_reason=${finishReason}). ` +
            `Response may have been truncated by token limit.`
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
    const pdfContext = await extractPdfText(pdfBase64);
    const verificationPrompt = buildVerificationUserPrompt(items, customInstructions);
    const verificationSchema = toStrictJsonSchema(
      VERIFICATION_TOOL.input_schema
    );

    // Extract positioned text for verification cross-check
    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const positionedText = await extractTextWithPositions(pdfBuffer);
    const positionedTextContext = positionedText
      ? `\n\n--- PDF Text Layer (with coordinates) ---\n${positionedText}`
      : "";

    const response = await callWithRetry(
      () =>
        this.client.chat.completions.create({
          model: this.model,
          max_completion_tokens: 8192,
          temperature: 0.1,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "verify_quantities",
              schema: verificationSchema,
              strict: true,
            },
          },
          messages: [
            { role: "system", content: VERIFICATION_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                {
                  type: "file",
                  file: {
                    filename: "plan.pdf",
                    file_data: `data:application/pdf;base64,${pdfBase64}`,
                  },
                },
                {
                  type: "text",
                  text: `${pdfContext}${positionedTextContext}\n\n${verificationPrompt}`,
                },
              ],
            },
          ],
        }),
      onRetry
    );

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return {
        corrections: [],
        additions: [],
        nameCorrections: [],
        verificationNotes: "OpenAI returned an empty response.",
      };
    }

    let result: VerificationResult;
    try {
      result = JSON.parse(content) as VerificationResult;
    } catch {
      const repaired = tryRepairTruncatedJson(content);
      if (repaired && typeof repaired === "object") {
        console.warn(`[openai] Repaired truncated verification JSON`);
        result = repaired as VerificationResult;
      } else {
        console.warn(`[openai] Could not parse verification response, returning empty`);
        return {
          corrections: [],
          additions: [],
          nameCorrections: [],
          verificationNotes: "Verification response was truncated and could not be repaired.",
        };
      }
    }

    if (!result.corrections || !Array.isArray(result.corrections))
      result.corrections = [];
    if (!result.additions || !Array.isArray(result.additions))
      result.additions = [];
    if (!result.nameCorrections || !Array.isArray(result.nameCorrections))
      result.nameCorrections = [];
    if (!result.verificationNotes)
      result.verificationNotes = "";
    return result;
  }
}
