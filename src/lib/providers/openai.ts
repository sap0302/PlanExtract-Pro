import OpenAI from "openai";
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
 * Retry wrapper for OpenAI API calls.
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
      const isRateLimit =
        errObj?.status === 429 ||
        (error instanceof Error &&
          (error.message.includes("429") ||
            error.message.includes("rate_limit")));

      if (!isRateLimit || attempt === MAX_RETRIES) throw error;

      const waitSec = DEFAULT_BACKOFF_SECONDS[attempt];
      console.log(
        `Rate limited by OpenAI API. Waiting ${waitSec}s before retry ${attempt + 1}/${MAX_RETRIES}...`
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
    this.model = config.model || "gpt-5.2";
  }

  async extractFromPDF(
    pdfBase64: string,
    userPrompt?: string,
    onRetry?: OnRetryCallback
  ): Promise<ExtractionResult> {
    const pdfContext = await extractPdfText(pdfBase64);
    const extractionSchema = toStrictJsonSchema(EXTRACTION_TOOL.input_schema);

    const response = await callWithRetry(
      () =>
        this.client.chat.completions.create({
          model: this.model,
          max_completion_tokens: 32768,
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
                  text: `${pdfContext}\n\n${userPrompt || USER_PROMPT}`,
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

    const result = JSON.parse(content) as ExtractionResult;
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
                  text: `${pdfContext}\n\n${verificationPrompt}`,
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

    const result = JSON.parse(content) as VerificationResult;
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
