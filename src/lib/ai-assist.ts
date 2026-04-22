/**
 * Lightweight AI image analysis utility for measurement-assist features.
 *
 * Used by:
 *   - Auto-Scale: sends rendered PDF page to AI → returns scale bar coordinates
 *   - Region Highlighting: sends page + item name → returns bounding boxes
 *
 * Intentionally standalone — does NOT modify the AIProvider interface.
 * Uses cheaper/faster models than extraction (sonnet, gpt-4o, flash).
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

export interface AIAssistConfig {
  provider: "anthropic" | "openai" | "gemini";
  apiKey: string;
  model?: string;
}

// Default to fast, cheap models for lightweight image analysis
const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  gemini: "gemini-2.5-flash",
};

/**
 * Send a JPEG image + prompt to an AI provider and get a JSON response.
 *
 * @param config    Provider name, API key, optional model override
 * @param imageJpegBase64   Base64-encoded JPEG image
 * @param prompt    Text prompt describing what to find/analyze
 * @param maxTokens Max output tokens (default 1024 — keep low for speed)
 * @returns         Parsed JSON response of type T
 */
export async function analyzeImage<T>(
  config: AIAssistConfig,
  imageJpegBase64: string,
  prompt: string,
  maxTokens: number = 1024
): Promise<T> {
  const model = config.model || DEFAULT_MODELS[config.provider];
  let rawText: string;

  const MAX_RETRIES = 2;
  const BACKOFF_SECONDS = [15, 30];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      rawText = await callProvider(config.provider, config.apiKey, model, imageJpegBase64, prompt, maxTokens);
      return parseJsonResponse<T>(rawText);
    } catch (error: unknown) {
      const errObj = error as Record<string, unknown>;
      const status = errObj?.status;
      const msg = error instanceof Error ? error.message.toLowerCase() : "";

      const isRetryable =
        status === 429 || status === 503 || status === 529 ||
        msg.includes("429") || msg.includes("503") ||
        msg.includes("rate_limit") || msg.includes("overloaded") ||
        msg.includes("high demand");

      if (!isRetryable || attempt === MAX_RETRIES) throw error;

      const waitSec = BACKOFF_SECONDS[attempt];
      console.log(
        `[ai-assist] ${config.provider} ${status || "error"}: retrying in ${waitSec}s (${attempt + 1}/${MAX_RETRIES})...`
      );
      await new Promise((r) => setTimeout(r, waitSec * 1000));
    }
  }

  throw new Error("Unexpected: exceeded retry loop");
}

/** Provider-specific API call implementations */
async function callProvider(
  provider: string,
  apiKey: string,
  model: string,
  imageBase64: string,
  prompt: string,
  maxTokens: number
): Promise<string> {
  switch (provider) {
    case "anthropic": {
      const client = new Anthropic({ apiKey });
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: imageBase64,
                },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      });
      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("Anthropic returned no text content");
      }
      return textBlock.text;
    }

    case "openai": {
      const client = new OpenAI({ apiKey, timeout: 60_000 });
      const response = await client.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`,
                  detail: "high",
                },
              },
              { type: "text", text: prompt },
            ],
          },
        ],
      });
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error("OpenAI returned empty response");
      return content;
    }

    case "gemini": {
      const genAI = new GoogleGenerativeAI(apiKey);
      const geminiModel = genAI.getGenerativeModel(
        {
          model,
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: maxTokens,
            responseMimeType: "application/json",
          } as Parameters<typeof genAI.getGenerativeModel>[0]["generationConfig"],
        },
        { timeout: 60_000 }
      );
      const result = await geminiModel.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
              { text: prompt },
            ],
          },
        ],
      });
      return result.response.text();
    }

    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/** Parse JSON from AI response, stripping markdown fences if present */
function parseJsonResponse<T>(raw: string): T {
  let text = raw.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  return JSON.parse(text) as T;
}
