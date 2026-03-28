import type { Provider, ProviderConfig, AIProvider } from "./types";
import { AnthropicProvider } from "./anthropic";
import { OpenAIProvider } from "./openai";
import { GeminiProvider } from "./gemini";

/**
 * Create an AI provider instance for the given provider name and API key.
 */
export function createProvider(
  provider: Provider,
  apiKey: string,
  model?: string
): AIProvider {
  const config: ProviderConfig = { apiKey, model };
  switch (provider) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    case "gemini":
      return new GeminiProvider(config);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// Re-export verification utilities (shared between route.ts and chunked.ts)
export {
  applyVerificationCorrections,
  applyNameCorrections,
  processVerificationAdditions,
} from "./verification-utils";

export { extractFromPDFChunked, deduplicateItems } from "./chunked";
export { isPdfProcessingError } from "./anthropic";
export type {
  Provider,
  AIProvider,
  ExtractionResult,
  VerificationResult,
  ExtractedItem,
  QuantityCorrection,
  NameCorrection,
  VerificationAddition,
} from "./types";
