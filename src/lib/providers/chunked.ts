import { isPdfProcessingError } from "./anthropic";
import {
  applyVerificationCorrections,
  applyNameCorrections,
  processVerificationAdditions,
} from "./verification-utils";
import type {
  AIProvider,
  ExtractionResult,
  ExtractedItem,
  QuantityMethod,
  OnRetryCallback,
} from "./types";

/**
 * Confidence ranking for merge decisions: higher = more trustworthy.
 */
const CONFIDENCE_RANK: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Quantity method precision ranking: higher = more reliable measurement.
 */
const METHOD_RANK: Record<string, number> = {
  station_math: 5,
  callout: 4,
  schedule: 3,
  count: 2,
  scale_estimate: 1,
};

/**
 * Check if a number is suspiciously round (divisible by 10+).
 * Round numbers from scale_estimate methods are likely hallucinated.
 */
function isRoundNumber(n: number): boolean {
  return n > 0 && n % 50 === 0;
}

/**
 * Normalize a dedupeKey for cross-chunk comparison.
 * Lowercases, strips extra whitespace, and removes the sheet component
 * from count-type keys (since the same physical item appears on multiple sheets).
 */
function normalizeDedupeKey(key: string): string {
  return key.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Build a fallback dedupeKey when the AI doesn't provide one.
 * Includes more context than just name|system|measurementType.
 */
function buildFallbackKey(item: ExtractedItem): string {
  const base = `${item.name}|${item.system}|${item.measurementType}`;
  if (item.measurementType === "linear" && item.nodeRange) {
    return `${base}|${item.nodeRange}`;
  }
  if (item.measurementType === "area" && item.sourceSheetId) {
    return `${base}|${item.sourceSheetId}`;
  }
  return base;
}

/**
 * Check if two station ranges overlap (e.g. "0+00-5+00" and "3+00-5+00").
 * Returns true if ranges overlap or if we can't parse them.
 */
function stationRangesOverlap(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const parse = (r: string): [number, number] | null => {
    // Match patterns like "0+00-5+00", "0+00 to 5+00", "STA 0+00 - STA 5+00"
    const nums = r.match(/(\d+)\+(\d+)/g);
    if (!nums || nums.length < 2) return null;
    const toFeet = (s: string) => {
      const m = s.match(/(\d+)\+(\d+)/);
      return m ? parseInt(m[1]) * 100 + parseInt(m[2]) : NaN;
    };
    const start = toFeet(nums[0]);
    const end = toFeet(nums[nums.length - 1]);
    if (isNaN(start) || isNaN(end)) return null;
    return [Math.min(start, end), Math.max(start, end)];
  };
  const rangeA = parse(a);
  const rangeB = parse(b);
  if (!rangeA || !rangeB) return false;
  return rangeA[0] < rangeB[1] && rangeB[0] < rangeA[1];
}

/**
 * Deduplicate extracted items with measurement-type-aware merge strategies.
 *
 * Key principles:
 * - Same physical item on multiple sheets = ONE item (not summed)
 * - Linear: only sum genuinely non-overlapping segments
 * - Count: keep MAX across sheets (same fitting appears on plan view + detail)
 * - Area: keep higher confidence per sheet
 */
export function deduplicateItems(items: ExtractedItem[]): ExtractedItem[] {
  const itemMap = new Map<string, ExtractedItem>();

  for (const item of items) {
    const rawKey = item.dedupeKey
      ? normalizeDedupeKey(item.dedupeKey)
      : normalizeDedupeKey(buildFallbackKey(item));

    if (itemMap.has(rawKey)) {
      const existing = itemMap.get(rawKey)!;
      const existingRank = CONFIDENCE_RANK[existing.confidence] ?? 1;
      const newRank = CONFIDENCE_RANK[item.confidence] ?? 1;

      // --- Measurement-type-aware merge strategy ---
      if (item.measurementType === "linear") {
        mergeLinearItem(existing, item, existingRank, newRank, itemMap, rawKey);
      } else if (item.measurementType === "count") {
        mergeCountItem(existing, item, existingRank, newRank, itemMap, rawKey);
      } else {
        // Area: keep higher confidence version
        if (newRank > existingRank) {
          itemMap.set(rawKey, { ...item });
        } else if (newRank === existingRank && item.quantity > existing.quantity) {
          itemMap.set(rawKey, { ...item });
        }
      }

      // Merge metadata on the winner
      const winner = itemMap.get(rawKey)!;
      mergeMetadata(winner, item);

      // Round-number detection: if both items had round quantities and both
      // used scale_estimate, the merged result is likely hallucinated
      if (
        isRoundNumber(existing.quantity) &&
        isRoundNumber(item.quantity) &&
        existing.quantityMethod === "scale_estimate" &&
        item.quantityMethod === "scale_estimate"
      ) {
        winner.confidence = "low";
      }
    } else {
      itemMap.set(rawKey, { ...item });
    }
  }

  return Array.from(itemMap.values());
}

/**
 * Merge strategy for linear items.
 * Only sum when segments are genuinely non-overlapping.
 */
function mergeLinearItem(
  existing: ExtractedItem,
  incoming: ExtractedItem,
  existingRank: number,
  newRank: number,
  itemMap: Map<string, ExtractedItem>,
  key: string
): void {
  const existingMethod = METHOD_RANK[existing.quantityMethod || ""] ?? 0;
  const newMethod = METHOD_RANK[incoming.quantityMethod || ""] ?? 0;

  // If station ranges overlap → same pipe run, keep more precise method
  if (stationRangesOverlap(existing.stationRange, incoming.stationRange)) {
    if (newMethod > existingMethod) {
      itemMap.set(key, { ...incoming });
    } else if (newMethod === existingMethod && newRank > existingRank) {
      itemMap.set(key, { ...incoming });
    }
    return;
  }

  // If identical node ranges → same segment, keep higher confidence
  if (existing.nodeRange && incoming.nodeRange && existing.nodeRange === incoming.nodeRange) {
    if (newRank > existingRank) {
      itemMap.set(key, { ...incoming });
    }
    return;
  }

  // Both have station ranges but non-overlapping → genuinely different segments, sum
  if (existing.stationRange && incoming.stationRange) {
    existing.quantity += incoming.quantity;
    if (newRank > existingRank) existing.confidence = incoming.confidence;
    if (newMethod > existingMethod) existing.quantityMethod = incoming.quantityMethod;
    return;
  }

  // No station info → keep higher confidence or larger (never sum blindly)
  if (newRank > existingRank) {
    itemMap.set(key, { ...incoming });
  } else if (newRank === existingRank) {
    // Same confidence: keep larger (most conservative — avoids under-counting)
    if (incoming.quantity > existing.quantity) {
      itemMap.set(key, { ...incoming });
    }
  }
}

/**
 * Merge strategy for count items.
 * Same physical fitting on multiple sheets = keep MAX (not sum).
 * Only sum when one is from schedule and other from visual count with different keys.
 */
function mergeCountItem(
  existing: ExtractedItem,
  incoming: ExtractedItem,
  existingRank: number,
  newRank: number,
  itemMap: Map<string, ExtractedItem>,
  key: string
): void {
  // Same sheet → duplicate observation, keep higher confidence
  if (existing.sourceSheetId && incoming.sourceSheetId &&
      existing.sourceSheetId === incoming.sourceSheetId) {
    if (newRank > existingRank) {
      itemMap.set(key, { ...incoming });
    }
    return;
  }

  // One is schedule-based and other is visual count → may legitimately sum
  const existingIsSchedule = existing.quantityMethod === "schedule";
  const incomingIsSchedule = incoming.quantityMethod === "schedule";
  if (existingIsSchedule !== incomingIsSchedule) {
    // Schedule + count for same item: trust the schedule (more authoritative)
    if (incomingIsSchedule) {
      itemMap.set(key, { ...incoming });
    }
    return;
  }

  // Different sheets, same method → same physical items shown on multiple views
  // Keep the MAX quantity (not sum) to avoid double-counting
  if (newRank > existingRank) {
    itemMap.set(key, { ...incoming });
  } else if (newRank === existingRank && incoming.quantity > existing.quantity) {
    itemMap.set(key, { ...incoming });
  }
}

/**
 * Merge metadata fields (descriptions, sourcePages, evidence, assumptions)
 * onto the winning item.
 */
function mergeMetadata(winner: ExtractedItem, other: ExtractedItem): void {
  if (other.description && other.description !== winner.description) {
    winner.description = winner.description
      ? `${winner.description}; ${other.description}`
      : other.description;
  }

  if (other.sourcePages?.length) {
    const pages = new Set(winner.sourcePages || []);
    for (const p of other.sourcePages) pages.add(p);
    winner.sourcePages = [...pages].sort((a, b) => a - b);
  }

  if (other.evidence && other.evidence !== winner.evidence) {
    winner.evidence = winner.evidence
      ? `${winner.evidence}; ${other.evidence}`
      : other.evidence;
  }

  if (other.assumptions?.length) {
    const existing = new Set(winner.assumptions || []);
    for (const a of other.assumptions) existing.add(a);
    winner.assumptions = [...existing];
  }
}

/**
 * Pre-dedup aggregation: merge rows with the same name|system|measurementType|sourceSheetId
 * into a single row. This catches the common case where the AI returns individual
 * fittings/segments as separate rows instead of aggregating them.
 *
 * - Count items: SUM quantities (6 rows of "FIRE HYDRANT W" qty=1 → 1 row qty=6)
 * - Linear items: SUM quantities (same pipe spec on same sheet = same runs)
 * - Area items: keep MAX quantity (same area measured twice → take larger)
 */
function aggregateItems(items: ExtractedItem[]): ExtractedItem[] {
  const groups = new Map<string, ExtractedItem[]>();

  for (const item of items) {
    const key = `${item.name}|${item.system}|${item.measurementType}|${item.sourceSheetId ?? ""}`;
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  const result: ExtractedItem[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // Find the entry with highest confidence to use as base
    const base = { ...group.reduce((best, cur) =>
      (CONFIDENCE_RANK[cur.confidence] ?? 0) > (CONFIDENCE_RANK[best.confidence] ?? 0) ? cur : best
    ) };

    if (base.measurementType === "count") {
      // Sum all count quantities
      base.quantity = group.reduce((sum, g) => sum + g.quantity, 0);
    } else if (base.measurementType === "linear") {
      // Sum all linear quantities
      base.quantity = group.reduce((sum, g) => sum + g.quantity, 0);
    } else {
      // Area: keep the largest
      base.quantity = Math.max(...group.map((g) => g.quantity));
    }

    // Use a generic dedupeKey for the merged item
    base.dedupeKey = buildFallbackKey(base);

    // Keep the best quantityMethod from the group
    const bestMethod = group.reduce((best, cur) => {
      const bestRank = METHOD_RANK[best.quantityMethod || ""] ?? 0;
      const curRank = METHOD_RANK[cur.quantityMethod || ""] ?? 0;
      return curRank > bestRank ? cur : best;
    });
    base.quantityMethod = bestMethod.quantityMethod;

    // Merge metadata from all items in the group
    for (let i = 0; i < group.length; i++) {
      if (group[i] !== base) {
        mergeMetadata(base, group[i]);
      }
    }

    result.push(base);
  }

  const merged = items.length - result.length;
  if (merged > 0) {
    console.log(
      `[chunked] Aggregated ${items.length} items → ${result.length} (merged ${merged} duplicate rows)`
    );
  }

  return result;
}

/**
 * Final cross-chunk merge: merge items with the same name|system|measurementType
 * that survived dedup because they had different AI-generated dedupeKeys.
 *
 * This handles the common case where the AI gives "8|DR18|W|MH-1->MH-5" from one
 * chunk and "8|DR18|W|STA-0+00" from another for the same pipe, or count items
 * like "8\" GATE VALVE W" from different sheets.
 *
 * Strategy:
 * - Linear: keep the item with the best quantityMethod; if same method, keep larger qty
 *   (station_math from one chunk is more authoritative than scale_estimate from another)
 * - Count: SUM quantities across chunks (different sheets have different fittings)
 * - Area: keep larger quantity
 */
function mergeCrossChunkDuplicates(items: ExtractedItem[]): ExtractedItem[] {
  const groups = new Map<string, ExtractedItem[]>();

  for (const item of items) {
    const key = `${item.name.toLowerCase().trim()}|${item.system}|${item.measurementType}`;
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  const result: ExtractedItem[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }

    // Sort by method rank desc, then confidence desc
    group.sort((a, b) => {
      const methodDiff = (METHOD_RANK[b.quantityMethod || ""] ?? 0) - (METHOD_RANK[a.quantityMethod || ""] ?? 0);
      if (methodDiff !== 0) return methodDiff;
      return (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0);
    });

    const base = { ...group[0] }; // Best method/confidence as base

    if (base.measurementType === "count") {
      // Count items from different sheets: SUM
      base.quantity = group.reduce((sum, g) => sum + g.quantity, 0);
    } else if (base.measurementType === "linear") {
      // Linear: if best item uses station_math, keep it (authoritative).
      // If a scale_estimate also exists, it's likely the same pipe — don't add.
      const stationItems = group.filter(g => g.quantityMethod === "station_math");
      const nonStationItems = group.filter(g => g.quantityMethod !== "station_math");
      if (stationItems.length > 0) {
        // Sum station_math items (genuinely different segments), ignore scale estimates
        base.quantity = stationItems.reduce((sum, g) => sum + g.quantity, 0);
        base.quantityMethod = "station_math" as QuantityMethod;
        if (nonStationItems.length > 0) {
          base.description = (base.description || "") +
            `; dropped ${nonStationItems.length} scale-estimated duplicate(s)`;
        }
      } else {
        // No station math: use median (robust against both over- and under-estimates)
        const quantities = group.map(g => g.quantity).filter(q => q > 0).sort((a, b) => a - b);
        if (quantities.length > 0) {
          const mid = Math.floor(quantities.length / 2);
          base.quantity = quantities.length % 2 === 0
            ? (quantities[mid - 1] + quantities[mid]) / 2
            : quantities[mid];
        } else {
          base.quantity = Math.max(...group.map(g => g.quantity));
        }
      }
    } else {
      // Area: use median (robust against scale misreads)
      const quantities = group.map(g => g.quantity).filter(q => q > 0).sort((a, b) => a - b);
      if (quantities.length > 0) {
        const mid = Math.floor(quantities.length / 2);
        base.quantity = quantities.length % 2 === 0
          ? (quantities[mid - 1] + quantities[mid]) / 2
          : quantities[mid];
      } else {
        base.quantity = Math.max(...group.map(g => g.quantity));
      }
    }

    // Merge metadata from all
    for (let i = 1; i < group.length; i++) {
      mergeMetadata(base, group[i]);
    }

    // Update dedupeKey to reflect merged state
    base.dedupeKey = buildFallbackKey(base);

    const merged = group.length - 1;
    console.log(
      `[crossmerge] Merged ${group.length} "${base.name}" → qty=${base.quantity} (${base.quantityMethod})`
    );

    result.push(base);
  }

  return result;
}

/**
 * Post-processing: apply deterministic name corrections and remove excluded items.
 * This runs AFTER AI extraction and dedup, fixing known systematic AI errors.
 */
function postProcessItems(items: ExtractedItem[]): ExtractedItem[] {
  // ── Name corrections: fix known AI naming patterns ──
  const NAME_CORRECTIONS: Array<{ pattern: RegExp; replacement: string | ((match: RegExpMatchArray, item: ExtractedItem) => string) }> = [
    // Storm drain HDPE fittings: "60° WYE SD" → "8X8 WYE HDPE SD"
    { pattern: /^60[°]?\s*WYE\s+SD$/i, replacement: "8X8 WYE HDPE SD" },
    // Storm bends without HDPE: "45° BEND SD" → "8\" 45 HDPE SD" (when storm system uses HDPE)
    { pattern: /^(\d+)[°]?\s*BEND\s+SD$/i, replacement: (m) => `8" ${m[1]} HDPE SD` },
    // "30° BEND SD" is actually a 90 (the AI confuses this) — but keep as-is, just add HDPE
    // Remove degree symbols from any remaining names
    { pattern: /(\d+)°/g, replacement: "$1" },
    // "8X1 TEE W" where branch is 1" → should be SADDLE (service tap, not branch)
    { pattern: /^(\d+)X([12])\s+TEE\s+W$/i, replacement: (m) => `${m[1]}X${m[2]} SADDLE W` },
  ];

  // ── Exclusion patterns: items that should not be in utility takeoffs ──
  const EXCLUSION_PATTERNS = [
    /SWPPP/i,
    /SILT\s*FENCE/i,
    /CONSTRUCTION\s*ENTRANCE/i,
    /WASHOUT/i,
    /INLET\s*PROTECTION/i,
    /EROSION\s*(BLANKET|CONTROL)/i,
    /CHECK\s*DAM/i,
    /FIBER\s*ROLL/i,
    /WATTLE/i,
    /^[12]"\s*(PLUG|VALVE)\s+W$/i,    // Small service plugs/valves
    /^6"\s*PLUG/i,                      // 6" plugs
  ];

  const result: ExtractedItem[] = [];

  for (const item of items) {
    // Check exclusion list
    if (EXCLUSION_PATTERNS.some(p => p.test(item.name))) {
      console.log(`[postprocess] Excluded: ${item.name}`);
      continue;
    }

    // Apply name corrections
    let correctedName = item.name;
    for (const { pattern, replacement } of NAME_CORRECTIONS) {
      if (typeof replacement === "string") {
        correctedName = correctedName.replace(pattern, replacement);
      } else {
        const match = correctedName.match(pattern);
        if (match) {
          correctedName = replacement(match, item);
        }
      }
    }
    if (correctedName !== item.name) {
      console.log(`[postprocess] Renamed: "${item.name}" → "${correctedName}"`);
      item.name = correctedName;
    }

    result.push(item);
  }

  // ── Second aggregation pass after name corrections ──
  // Name corrections may have created new duplicates (e.g., two items now both named "8X8 WYE HDPE SD")
  return aggregateItems(result);
}

/**
 * Process multiple PDF chunks through a provider and merge results.
 * Provider-agnostic version of the chunked extraction logic.
 */
export async function extractFromPDFChunked(
  provider: AIProvider,
  pdfChunks: string[],
  chunkLabels: string[],
  onProgress?: (
    chunkIndex: number,
    totalChunks: number,
    label: string
  ) => void,
  userPrompt?: string,
  onRetry?: OnRetryCallback,
  enableVerification?: boolean,
  customInstructions?: string | null
): Promise<ExtractionResult> {
  const allItems: ExtractedItem[] = [];
  const summaries: string[] = [];
  const failedChunks: string[] = [];

  for (let i = 0; i < pdfChunks.length; i++) {
    const label = chunkLabels[i] || `Chunk ${i + 1}`;
    console.log(`Processing chunk ${i + 1}/${pdfChunks.length}: ${label}`);

    if (onProgress) {
      onProgress(i, pdfChunks.length, label);
    }

    try {
      const result = await provider.extractFromPDF(
        pdfChunks[i],
        userPrompt,
        onRetry
      );
      if (result.summary) summaries.push(result.summary);
      console.log(
        `[chunked] Chunk ${i + 1} (${label}): extracted ${result.items.length} item(s)`
      );

      // Per-chunk verification: verify each chunk individually for accuracy
      if (enableVerification && result.items.length > 0) {
        try {
          console.log(
            `[chunked] Verifying chunk ${i + 1} (${label}): ${result.items.length} items...`
          );
          const verificationResult = await provider.verifyExtraction(
            pdfChunks[i],
            result.items,
            onRetry,
            customInstructions
          );

          let verifiedItems = [...result.items];

          if (verificationResult.corrections.length > 0) {
            const { correctedItems, correctionCount } =
              applyVerificationCorrections(
                verifiedItems,
                verificationResult.corrections
              );
            verifiedItems = correctedItems;
            if (correctionCount > 0) {
              console.log(
                `[chunked] Chunk ${i + 1}: ${correctionCount} quantity correction(s)`
              );
            }
          }

          if (verificationResult.nameCorrections?.length > 0) {
            const { renamedItems, renameCount } = applyNameCorrections(
              verifiedItems,
              verificationResult.nameCorrections
            );
            verifiedItems = renamedItems;
            if (renameCount > 0) {
              console.log(
                `[chunked] Chunk ${i + 1}: ${renameCount} name correction(s)`
              );
            }
          }

          if (verificationResult.additions?.length > 0) {
            // Pass previously-processed chunks' items to filter out duplicates
            const newItems = processVerificationAdditions(
              verificationResult.additions,
              allItems
            );
            if (newItems.length > 0) {
              verifiedItems = [...verifiedItems, ...newItems];
              console.log(
                `[chunked] Chunk ${i + 1}: ${newItems.length} item(s) added`
              );
            }
          }

          allItems.push(...verifiedItems);
          console.log(
            `[chunked] Chunk ${i + 1} verified: ${verifiedItems.length} items (was ${result.items.length})`
          );
        } catch (verifyError) {
          console.warn(
            `[chunked] Chunk ${i + 1} verification failed, using unverified items:`,
            verifyError instanceof Error
              ? verifyError.message
              : verifyError
          );
          allItems.push(...result.items);
        }
      } else {
        allItems.push(...result.items);
      }
    } catch (chunkError) {
      const errMsg =
        chunkError instanceof Error ? chunkError.message : String(chunkError);
      const errObj = chunkError as Record<string, unknown>;
      const isRecoverable =
        (provider.name === "anthropic" && isPdfProcessingError(chunkError)) ||
        errObj?.status === 413 ||
        errMsg.includes("413") ||
        errMsg.includes("request_too_large");

      if (isRecoverable) {
        console.warn(
          `[chunked] Chunk ${i + 1} (${label}) failed (${errMsg.slice(0, 100)}). Skipping.`
        );
        failedChunks.push(label);
        continue;
      }
      throw chunkError;
    }
  }

  if (failedChunks.length === pdfChunks.length) {
    throw new Error(
      "The AI could not process any chunk of this PDF. " +
        "The file may contain unsupported features. " +
        "Try re-exporting it or use page ranges."
    );
  }

  // Generate fallback dedupeKeys for items where the AI didn't provide one
  let missingKeyCount = 0;
  for (const item of allItems) {
    if (!item.dedupeKey) {
      missingKeyCount++;
      item.dedupeKey = buildFallbackKey(item);
    }
  }
  if (missingKeyCount > 0) {
    console.warn(
      `[chunked] Generated fallback dedupeKeys for ${missingKeyCount}/${allItems.length} items`
    );
  }

  // Pre-dedup aggregation: merge rows with identical name|system|type|sheet
  const aggregated = aggregateItems(allItems);
  let mergedItems = deduplicateItems(aggregated);

  // Post-merge verification: verify the deduplicated result against the first chunk
  // This catches errors introduced by merging (e.g. over-summation, missed dedup)
  if (enableVerification && mergedItems.length > 0 && pdfChunks.length > 1) {
    try {
      console.log(
        `[chunked] Post-merge verification: ${mergedItems.length} items against first chunk...`
      );
      const postMergeVerification = await provider.verifyExtraction(
        pdfChunks[0],
        mergedItems,
        onRetry,
        customInstructions
      );

      if (postMergeVerification.corrections.length > 0) {
        const { correctedItems, correctionCount } =
          applyVerificationCorrections(
            mergedItems,
            postMergeVerification.corrections
          );
        mergedItems = correctedItems;
        if (correctionCount > 0) {
          console.log(
            `[chunked] Post-merge: ${correctionCount} quantity correction(s)`
          );
        }
      }

      if (postMergeVerification.nameCorrections?.length > 0) {
        const { renamedItems, renameCount } = applyNameCorrections(
          mergedItems,
          postMergeVerification.nameCorrections
        );
        mergedItems = renamedItems;
        if (renameCount > 0) {
          console.log(
            `[chunked] Post-merge: ${renameCount} name correction(s)`
          );
        }
      }

      // Post-merge additions are filtered against existing items to prevent duplicates
      if (postMergeVerification.additions?.length > 0) {
        const newItems = processVerificationAdditions(
          postMergeVerification.additions,
          mergedItems
        );
        if (newItems.length > 0) {
          mergedItems = [...mergedItems, ...newItems];
          console.log(
            `[chunked] Post-merge: ${newItems.length} item(s) added`
          );
        }
      }

      console.log(
        `[chunked] Post-merge verification complete: ${mergedItems.length} items`
      );
    } catch (postMergeError) {
      console.warn(
        `[chunked] Post-merge verification failed, using unverified merge:`,
        postMergeError instanceof Error
          ? postMergeError.message
          : postMergeError
      );
    }
  }

  // Log zero-result diagnostic when no items extracted across all chunks
  if (mergedItems.length === 0 && pdfChunks.length > 0) {
    const processedCount = pdfChunks.length - failedChunks.length;
    console.warn(
      `[chunked] ZERO ITEMS extracted across ${processedCount} processed chunk(s) ` +
        `(${failedChunks.length} failed). This may indicate the PDF contains no civil sheets.`
    );
  }

  // Use the longest summary (cover sheets produce short generic summaries;
  // actual plan chunks produce more detailed project descriptions)
  const combinedSummary =
    summaries.length >= 1
      ? summaries.reduce((best, s) => (s.length > best.length ? s : best), "")
      : "";

  // Build warning notes
  let warningNote =
    failedChunks.length > 0
      ? ` (Warning: ${failedChunks.length} chunk(s) could not be processed: ${failedChunks.join(", ")})`
      : "";

  if (mergedItems.length === 0 && pdfChunks.length > 0) {
    const processedCount = pdfChunks.length - failedChunks.length;
    warningNote +=
      ` (Warning: No items were extracted from ${processedCount} processed chunk(s). ` +
      `The PDF may not contain civil plan sheets, or civil details may have been ` +
      `misidentified as non-extractable pages.)`;
  }

  // Post-processing: name corrections, exclusions, re-aggregation
  const beforePost = mergedItems.length;
  mergedItems = postProcessItems(mergedItems);

  // Final cross-chunk merge: items with same name|system|measurementType
  // that survived dedup with different dedupeKeys (common when AI gives
  // location-specific keys for the same logical item across chunks)
  mergedItems = mergeCrossChunkDuplicates(mergedItems);

  if (mergedItems.length !== beforePost) {
    console.log(
      `[chunked] Post-processing: ${beforePost} → ${mergedItems.length} items`
    );
  }

  return {
    summary: combinedSummary + warningNote,
    items: mergedItems,
  };
}
