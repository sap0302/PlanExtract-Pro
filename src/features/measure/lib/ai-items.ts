import { MANUAL_MEASURE_SUFFIX } from "./constants";
import type { AiMeasureItem, ExtractionData } from "../types";
import type { MeasurementShape } from "../components/measurement-canvas";

export function deriveAiMeasureItems(
  extraction: ExtractionData | null,
  measurements: MeasurementShape[]
): AiMeasureItem[] {
  if (!extraction?.items) return [];

  return extraction.items.flatMap((it) => {
    const needsMeasurement = it.name.endsWith(MANUAL_MEASURE_SUFFIX) && it.quantity === 0;
    if (!it.sourcePages) return [];
    if (measurements.some((m) => m.itemId === it.id)) return [];

    let pages: number[] = [];
    try {
      const parsed = JSON.parse(it.sourcePages) as number[];
      if (Array.isArray(parsed) && parsed.length > 0) pages = parsed;
    } catch {
      return [];
    }
    if (pages.length === 0) return [];

    const pageOccurrences = new Map<number, number>();
    for (const p of pages) pageOccurrences.set(p, (pageOccurrences.get(p) || 0) + 1);

    return Array.from(pageOccurrences.keys()).map((page) => ({
      id: it.id,
      name: needsMeasurement ? it.name.slice(0, -MANUAL_MEASURE_SUFFIX.length) : it.name,
      originalName: it.name,
      measurementType: it.measurementType as AiMeasureItem["measurementType"],
      system: it.system as AiMeasureItem["system"],
      unit: it.unit,
      quantity: it.measurementType === "count" ? pageOccurrences.get(page)! : it.quantity,
      sourceSheetId: it.sourceSheetId,
      evidence: it.evidence,
      needsMeasurement,
      page,
    }));
  });
}

export function extractQuotedTokens(text: string | null): string[] {
  if (!text) return [];
  const matches = text.match(/['"“”‘’]([^'"“”‘’]{3,60})['"“”‘’]/g) || [];
  return matches.map((m) => m.slice(1, -1).trim()).filter((s) => s.length >= 3);
}

export function highlightTokensForPage(items: AiMeasureItem[], page: number): string[] {
  const tokens = items
    .filter((it) => it.page === page)
    .flatMap((it) => [it.name, ...extractQuotedTokens(it.evidence)]);
  return Array.from(new Set(tokens.filter((s): s is string => !!s && s.trim().length >= 3)));
}
