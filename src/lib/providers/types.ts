export type Provider = "anthropic" | "openai" | "gemini";

export interface ProviderConfig {
  apiKey: string;
  model?: string;
}

export type QuantityMethod = "station_math" | "callout" | "schedule" | "count" | "scale_estimate";

export interface ExtractedItem {
  name: string;
  description?: string;
  measurementType: "area" | "count" | "linear";
  system: "water" | "storm_drain" | "wastewater" | "other";
  quantity: number;
  unit: "SQ FT" | "EA" | "FT";
  confidence: "high" | "medium" | "low";

  // Audit & traceability fields
  sourcePages?: number[];
  sourceSheetId?: string;
  quantityMethod?: QuantityMethod;
  evidence?: string;
  assumptions?: string[];
  dedupeKey?: string;
  nodeRange?: string;
  stationRange?: string;
  isDemo?: boolean;
  folderPath?: string;
}

export interface ExtractionResult {
  summary: string;
  items: ExtractedItem[];
}

export interface QuantityCorrection {
  name: string;
  originalQuantity: number;
  correctedQuantity: number;
  reason: string;
}

export interface NameCorrection {
  originalName: string;
  correctedName: string;
  reason: string;
}

export interface VerificationAddition extends ExtractedItem {
  reason: string;
}

// Verification diagnostic types
export interface ConnectivityIssue {
  itemName: string;
  issueType: "missing_branch" | "missing_valve" | "missing_lead" | "orphan_node";
  description: string;
}

export interface ScopeCheck {
  checkType: "services_vs_lots" | "hydrants_vs_frontage" | "manholes_vs_endpoints";
  expected: number;
  found: number;
  note: string;
}

export interface UncertaintyItem {
  name: string;
  reason: string;
  suggestedAction: string;
}

export interface DedupFlag {
  itemName: string;
  reason: string;
}

export interface VerificationResult {
  corrections: QuantityCorrection[];
  additions: VerificationAddition[];
  nameCorrections: NameCorrection[];
  verificationNotes: string;
  // Enhanced verification diagnostics
  connectivityIssues?: ConnectivityIssue[];
  scopeChecks?: ScopeCheck[];
  topUncertainties?: UncertaintyItem[];
  dedupFlags?: DedupFlag[];
}

export type OnRetryCallback = (
  attempt: number,
  waitSeconds: number
) => void | Promise<void>;

/**
 * Common interface that all AI providers must implement.
 */
export interface AIProvider {
  readonly name: Provider;

  extractFromPDF(
    pdfBase64: string,
    userPrompt?: string,
    onRetry?: OnRetryCallback
  ): Promise<ExtractionResult>;

  verifyExtraction(
    pdfBase64: string,
    items: ExtractedItem[],
    onRetry?: OnRetryCallback,
    customInstructions?: string | null
  ): Promise<VerificationResult>;
}
