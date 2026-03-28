import type { ExtractionResult, ExtractedItem, Provider } from "./types";

/**
 * Normalize an item name for matching across models.
 * Strips whitespace, lowercases, removes extra quotes/spaces.
 */
function normalizeItemName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[""'']/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a match key for an item: normalized name + system + measurementType.
 */
function itemKey(item: ExtractedItem): string {
  return `${normalizeItemName(item.name)}|${item.system}|${item.measurementType}`;
}

/**
 * Check if a quantity looks like a round estimate (multiple of 10, ≥ 10).
 */
function isRoundEstimate(qty: number): boolean {
  return qty >= 10 && qty === Math.round(qty) && qty % 10 === 0;
}

/**
 * Merge two extractions from different AI models into a consensus result.
 *
 * Strategy:
 * - Items found by BOTH models → high confidence, prefer precise quantities
 * - Items found by only one model → keep at original confidence
 * - For quantity disagreements:
 *   - COUNT items: average and round
 *   - LINEAR/AREA items: prefer the more precise (non-round) quantity;
 *     if both are precise or both round, average them
 * - Flag large disagreements (>20% difference) in description
 */
export function mergeExtractions(
  primary: ExtractionResult,
  secondary: ExtractionResult
): ExtractionResult {
  const primaryMap = new Map<string, ExtractedItem>();
  const secondaryMap = new Map<string, ExtractedItem>();

  for (const item of primary.items) {
    primaryMap.set(itemKey(item), item);
  }
  for (const item of secondary.items) {
    secondaryMap.set(itemKey(item), item);
  }

  const mergedItems: ExtractedItem[] = [];
  const processedKeys = new Set<string>();

  // Process items found in primary
  for (const [key, pItem] of primaryMap) {
    processedKeys.add(key);
    const sItem = secondaryMap.get(key);

    if (sItem) {
      // Found by BOTH models — merge with consensus
      const merged = mergeItem(pItem, sItem);
      mergedItems.push(merged);
    } else {
      // Only in primary — keep as-is
      mergedItems.push({ ...pItem });
    }
  }

  // Process items found only in secondary
  for (const [key, sItem] of secondaryMap) {
    if (!processedKeys.has(key)) {
      mergedItems.push({ ...sItem });
    }
  }

  // Use the longer (more detailed) summary
  const summary =
    primary.summary.length >= secondary.summary.length
      ? primary.summary
      : secondary.summary;

  return { summary, items: mergedItems };
}

/**
 * Labeled extraction result from a specific provider.
 */
export interface LabeledResult {
  provider: Provider;
  result: ExtractionResult;
}

/**
 * Merge N extractions from different AI models into a consensus result.
 *
 * Strategy:
 * - Items found by ≥2 providers → confidence "high"
 * - Items found by only 1 provider → keep at original confidence, note which provider found it
 * - COUNT: median of all values, rounded
 * - LINEAR/AREA: prefer precise (non-round) values; median of precise values, or median of all if all round
 * - Preserves metadata (evidence, sourcePages, etc.) from the highest-confidence provider
 */
export function mergeExtractionsNWay(
  labeled: LabeledResult[]
): ExtractionResult {
  if (labeled.length === 0) return { summary: "", items: [] };
  if (labeled.length === 1) return labeled[0].result;
  if (labeled.length === 2) return mergeExtractions(labeled[0].result, labeled[1].result);

  // Build a map: itemKey → array of { provider, item }
  const itemMap = new Map<string, Array<{ provider: Provider; item: ExtractedItem }>>();

  for (const { provider, result } of labeled) {
    for (const item of result.items) {
      const key = itemKey(item);
      const group = itemMap.get(key);
      if (group) {
        group.push({ provider, item });
      } else {
        itemMap.set(key, [{ provider, item }]);
      }
    }
  }

  const totalProviders = labeled.length;
  const mergedItems: ExtractedItem[] = [];

  for (const [, group] of itemMap) {
    const foundByCount = group.length;
    const items = group.map((g) => g.item);
    const providers = group.map((g) => g.provider);

    // Pick the best base item (highest confidence, then most metadata)
    const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
    const base = { ...items.reduce((best, cur) =>
      (CONF_RANK[cur.confidence || "medium"] ?? 0) > (CONF_RANK[best.confidence || "medium"] ?? 0) ? cur : best
    ) };

    // Resolve quantity
    const quantities = items.map((i) => i.quantity).filter((q) => q > 0);
    if (quantities.length > 0) {
      base.quantity = resolveQuantityNWay(quantities, base.measurementType);
    }

    // Set confidence based on agreement
    if (foundByCount >= Math.ceil(totalProviders / 2)) {
      base.confidence = "high";
    } else if (foundByCount === 1) {
      // Single provider — keep original confidence but add note
      const providerName = providers[0];
      base.description = base.description
        ? `${base.description}; (found by ${providerName} only)`
        : `(found by ${providerName} only)`;
    } else {
      base.confidence = "medium";
    }

    // Merge metadata from all providers
    const allPages = new Set<number>();
    const allEvidence: string[] = [];
    for (const item of items) {
      if (item.sourcePages) {
        for (const p of item.sourcePages) allPages.add(p);
      }
      if (item.evidence) allEvidence.push(item.evidence);
    }
    if (allPages.size > 0) base.sourcePages = [...allPages].sort((a, b) => a - b);
    if (allEvidence.length > 1) {
      base.evidence = allEvidence[0]; // Keep primary evidence, don't bloat
    }

    // Flag quantity disagreements
    if (quantities.length >= 2) {
      const max = Math.max(...quantities);
      const min = Math.min(...quantities);
      const avg = quantities.reduce((s, q) => s + q, 0) / quantities.length;
      const pctSpread = avg > 0 ? ((max - min) / avg) * 100 : 0;
      if (pctSpread > 30) {
        const qtyStr = quantities.map((q) => q.toFixed(1)).join(", ");
        base.description = (base.description || "") +
          `; Providers disagree on qty: [${qtyStr}] (${pctSpread.toFixed(0)}% spread)`;
      }
    }

    mergedItems.push(base);
  }

  // Use the longest summary
  const summary = labeled.reduce((best, cur) =>
    cur.result.summary.length > best.result.summary.length ? cur : best
  ).result.summary;

  console.log(
    `[consensus] Merged ${labeled.length} providers: ${labeled.map((l) => l.provider).join(", ")} → ${mergedItems.length} items`
  );

  return { summary, items: mergedItems };
}

/**
 * Resolve quantity from multiple provider values.
 */
function resolveQuantityNWay(quantities: number[], measurementType: string): number {
  if (quantities.length === 1) return quantities[0];

  const sorted = [...quantities].sort((a, b) => a - b);

  if (measurementType === "count") {
    // COUNT: median, rounded
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    return Math.round(median);
  }

  // LINEAR/AREA: prefer precise (non-round) values
  const precise = sorted.filter((q) => !isRoundEstimate(q));
  const source = precise.length > 0 ? precise : sorted;
  const mid = Math.floor(source.length / 2);
  return source.length % 2 === 0
    ? (source[mid - 1] + source[mid]) / 2
    : source[mid];
}

/**
 * Merge two matched items from different models.
 */
function mergeItem(
  primary: ExtractedItem,
  secondary: ExtractedItem
): ExtractedItem {
  const pQty = primary.quantity;
  const sQty = secondary.quantity;

  let mergedQty: number;
  let disagreementNote = "";

  // Check for significant disagreement
  const avg = (pQty + sQty) / 2;
  const diff = Math.abs(pQty - sQty);
  const pctDiff = avg > 0 ? (diff / avg) * 100 : 0;

  if (pctDiff > 20) {
    disagreementNote = `Models disagree: ${pQty.toFixed(2)} vs ${sQty.toFixed(2)} (${pctDiff.toFixed(0)}% diff)`;
  }

  if (primary.measurementType === "count") {
    // COUNT: average and round to nearest integer
    mergedQty = Math.round((pQty + sQty) / 2);
  } else {
    // LINEAR/AREA: prefer precise (non-round) quantity
    const pRound = isRoundEstimate(pQty);
    const sRound = isRoundEstimate(sQty);

    if (pRound && !sRound) {
      mergedQty = sQty; // Secondary is more precise
    } else if (!pRound && sRound) {
      mergedQty = pQty; // Primary is more precise
    } else {
      // Both precise or both round — average
      mergedQty = (pQty + sQty) / 2;
    }
  }

  // Merge descriptions
  let description = primary.description || secondary.description || "";
  if (disagreementNote) {
    description = description
      ? `${description}; ${disagreementNote}`
      : disagreementNote;
  }

  return {
    name: primary.name, // Keep primary naming convention
    description,
    measurementType: primary.measurementType,
    system: primary.system,
    quantity: mergedQty,
    unit: primary.unit,
    confidence: "high", // Both models agree this item exists → high confidence
  };
}
