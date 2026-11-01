import type { ExtractionData } from "../types";

export function pixelsPerFootForPage(
  extraction: ExtractionData | null,
  page: number
): number | null {
  if (!extraction) return null;
  if (extraction.scalePerPageJson) {
    try {
      const perPage = JSON.parse(extraction.scalePerPageJson) as Record<string, number>;
      const override = perPage[String(page)];
      if (override != null) return override;
    } catch {
      // fall through to the extraction-wide scale
    }
  }
  return extraction.scalePixelsPerFoot;
}

export function isPageCalibrated(extraction: ExtractionData | null, page: number): boolean {
  const ppf = pixelsPerFootForPage(extraction, page);
  return ppf != null && ppf > 0;
}

export function withPageScale(
  extraction: ExtractionData,
  page: number,
  pixelsPerFoot: number,
  applyToAllPages: boolean
): ExtractionData {
  if (applyToAllPages) {
    return { ...extraction, scalePixelsPerFoot: pixelsPerFoot };
  }

  let perPage: Record<string, number> = {};
  if (extraction.scalePerPageJson) {
    try {
      perPage = JSON.parse(extraction.scalePerPageJson);
    } catch {
      perPage = {};
    }
  }
  perPage[String(page)] = pixelsPerFoot;
  return { ...extraction, scalePerPageJson: JSON.stringify(perPage) };
}
