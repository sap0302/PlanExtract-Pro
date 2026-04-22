import { isPdfProcessingError, AnthropicProvider } from "./anthropic";
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
 * Magic suffix appended to item names for Tier 3 placeholder rows — items
 * the AI detected on the plans but cannot reliably measure. The inventory UI
 * checks for this suffix to show yellow-highlighted rows with a "Measure"
 * button that opens the measurement tool focused on that item.
 *
 * When a human draws a measurement in the measurement tool and clicks
 * "Add to items", the measurements POST route promotes the placeholder
 * to a regular item (strips the suffix, sets the measured quantity).
 */
export const MANUAL_MEASURE_SUFFIX = " - MEASURE MANUALLY";

/**
 * Detect whether an extracted item is a Tier 3 placeholder row that needs
 * human measurement. Placeholders have qty=0 AND the magic name suffix.
 */
export function isManualPlaceholder(
  item: Pick<ExtractedItem, "name" | "quantity"> | { name: string; quantity: number }
): boolean {
  return item.name.endsWith(MANUAL_MEASURE_SUFFIX) && item.quantity === 0;
}

/**
 * Pick 6-10 high-leverage items from a merged extraction that are worth
 * re-verifying with a focused prompt. Returns items most likely to have
 * quantity errors — these are the ones that move the takeoff accuracy the most.
 *
 * Selection criteria (scored, top 10 selected):
 *   - Linear items using scale_estimate method (inherently noisy)
 *   - Large linear items (qty > 400 FT) regardless of method
 *   - All SSMH items (depth errors compound across the project)
 *   - All rip rap / pilot flume area items (scale_estimate noise)
 *   - Low-confidence items
 *
 * Tier 3 placeholder rows (qty=0, "- MEASURE MANUALLY" suffix) are
 * NEVER picked — they are meant for human measurement, not AI re-verification.
 */
export function pickHighValueItemsForVerification(
  items: ExtractedItem[]
): ExtractedItem[] {
  const picks = new Set<ExtractedItem>();

  // Skip placeholders — they are meant for humans, not AI re-verification.
  const nonPlaceholders = items.filter((it) => !isManualPlaceholder(it));

  // 1. Rip rap / pilot flume / outlet structure — always noisy on scale_estimate
  for (const item of nonPlaceholders) {
    if (
      /\b(RIP\s*RAP|PILOT\s+FLUME|PILOT\s+CHANNEL|OUTLET\s+STRUCTURE|WEIR\s+STRUCTURE)\b/i.test(
        item.name
      )
    ) {
      picks.add(item);
    }
  }

  // 2. SSMH items — depth errors compound and reference uses specific depths
  for (const item of nonPlaceholders) {
    if (/\bSSMH\b/i.test(item.name)) {
      picks.add(item);
    }
  }

  // 3. Largest linear items (top 5 by quantity, regardless of method)
  const linearByQty = nonPlaceholders
    .filter(
      (it) =>
        it.measurementType === "linear" &&
        it.quantity > 100 &&
        !picks.has(it)
    )
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5);
  for (const item of linearByQty) picks.add(item);

  // 4. Any item that is explicitly low-confidence
  for (const item of nonPlaceholders) {
    if (item.confidence === "low" && !picks.has(item)) {
      picks.add(item);
      if (picks.size >= 12) break;
    }
  }

  // Cap at 10 to keep API cost bounded (~$0.50-1.00 on Opus per batch)
  return Array.from(picks).slice(0, 10);
}

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
      // ── Same-sheet linear items: MAX, not SUM ──
      // The grouping key for this aggregation is (name, system, type, sheet).
      // If multiple items hit this group, they all share the same NAME on the
      // same SHEET — which means they describe the SAME physical pipe run, not
      // independent segments. Per extraction rule 11 ("Segments of the same
      // size and material on the same sheet should be SUMMED into one row"),
      // the AI is expected to have already summed multiple segments into one
      // row. When we see duplicates here, they're almost always the same
      // extraction emitted twice (e.g. AI extracted the same profile from two
      // passes, or a chunk/verification cycle produced two rows with slightly
      // different evidence).
      //
      // SUM in that case double-counts. MAX keeps the best single read.
      //
      // Legitimately different segments on the same sheet would require the AI
      // to violate rule 11 to produce two separate rows — uncommon. Cross-sheet
      // legit differences are merged downstream in mergeCrossChunkDuplicates,
      // which uses its own size-aware logic.
      const maxQty = Math.max(...group.map((g) => g.quantity));
      const sumQty = group.reduce((sum, g) => sum + g.quantity, 0);
      base.quantity = maxQty;
      if (group.length > 1 && sumQty > maxQty * 1.1) {
        console.log(
          `[aggregate] Linear same-sheet MAX: "${base.name}" on ${base.sourceSheetId ?? "?"} — ${group.length} rows, kept ${maxQty} FT (dropped ${(sumQty - maxQty).toFixed(2)} FT of double-count)`
        );
      }
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
 * Canonicalize an item name so cross-chunk merge groups known synonyms
 * together. Civil plan sets commonly reference the same physical item with
 * different wording on different sheets — e.g. a fire department connection
 * shows up as "FDC" on the landscape plan, "REMOTE FDC ASSY" on the civil
 * dimension control plan, and "FDC ASSY" on the paving plan. Without
 * canonicalization each variant lands in its own cross-chunk group and the
 * final inventory has 3 duplicate rows instead of one.
 *
 * This function only normalizes SPECIFIC known-duplicate patterns. Everything
 * else passes through as uppercase-trimmed (preserves the existing behavior).
 *
 * Patterns observed in real extractions:
 * - Fire department connection: FDC / REMOTE FDC ASSY / FDC ASSY / FIRE DEPARTMENT CONNECTION
 * - Water meter (no size, not irrigation): WM / WATER METER / WM WATER METER
 * - Irrigation meter: IRR WM / IRR WATER METER / IRR METER BOX ASSY / 1" IRR METER BOX ASSY
 * - Same-size water-main placeholders across material specs:
 *   "12\" PVC W - MEASURE MANUALLY" and "12\" DR18 W - MEASURE MANUALLY"
 *   both refer to the same pipe. Since placeholders have qty=0 and exist
 *   just to flag manual measurement, merging is safe.
 */
function canonicalizeMergeKey(name: string, quantity: number): string {
  const upper = name.toUpperCase().trim();

  // Placeholder merge: strip material spec so same-size placeholders collapse
  // to one row regardless of what material the AI guessed (PVC vs DR18 etc.).
  // Only applies to qty=0 items with the "- MEASURE MANUALLY" suffix.
  if (upper.endsWith(" - MEASURE MANUALLY") && quantity === 0) {
    // "12\" PVC W - MEASURE MANUALLY" → "12\" W - MEASURE MANUALLY"
    // Matches: number + optional quote/inch + space + material word + space + system suffix
    return upper.replace(/^(\d+["']?)\s+[A-Z]+\d*\s+(W|WW|SD)\b/, "$1 $2");
  }

  // Fire department connection assembly — all variants refer to the same item
  if (/^(REMOTE\s+)?FDC\b|^FIRE\s+DEPARTMENT\s+CONNECTION\b/i.test(upper)) {
    return "FDC ASSY W";
  }

  // Irrigation meter assembly — requires BOTH "IRR" and a meter keyword,
  // so it doesn't accidentally match non-irrigation meters
  if (/\bIRR(IGATION)?\b/i.test(upper) && /\b(WM|WATER\s+METER|METER\s+BOX|METER\s+ASSY|METER)\b/i.test(upper)) {
    return "IRR METER BOX ASSY W";
  }

  // Plain water meter variations (no size prefix, no IRR)
  // Intentionally strict so "3\" WATER METER IN VAULT" isn't swept up
  if (/^(WM|WATER\s+METER|WM\s+WATER\s+METER)\s*$/i.test(upper)) {
    return "WATER METER W";
  }

  // Default: return the lowercased trimmed name as before
  return upper.toLowerCase();
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
 * - Count (default): SUM quantities across chunks (different sheets have different fittings)
 * - Count (SSMH / double-counted structures): take MAX across chunks — these are
 *   the SAME physical structures appearing on both plan view and profile sheet,
 *   so we should use the highest single count, not the sum
 * - Area: keep larger quantity
 * - Placeholders (qty=0 with "- MEASURE MANUALLY" suffix): deduped to a single row,
 *   evidence merged across all detections
 */
function mergeCrossChunkDuplicates(items: ExtractedItem[]): ExtractedItem[] {
  const groups = new Map<string, ExtractedItem[]>();

  for (const item of items) {
    const key = `${canonicalizeMergeKey(item.name, item.quantity)}|${item.system}|${item.measurementType}`;
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

    // PLACEHOLDER FAST PATH — if all items in the group are placeholders,
    // keep one and merge the evidence strings. No summing or math.
    if (group.every(isManualPlaceholder)) {
      const base = { ...group[0] };
      const allEvidence = group
        .map((g) => g.evidence)
        .filter((e): e is string => Boolean(e));
      if (allEvidence.length > 0) {
        base.evidence = allEvidence.join(" | ");
      }
      console.log(
        `[crossmerge] Merged ${group.length} placeholders for "${base.name}"`
      );
      result.push(base);
      continue;
    }

    // Sort by method rank desc, then confidence desc
    group.sort((a, b) => {
      const methodDiff = (METHOD_RANK[b.quantityMethod || ""] ?? 0) - (METHOD_RANK[a.quantityMethod || ""] ?? 0);
      if (methodDiff !== 0) return methodDiff;
      return (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0);
    });

    const base = { ...group[0] }; // Best method/confidence as base

    // Detect items that commonly appear on BOTH plan view and profile and
    // should NOT be summed across chunks — these are the same physical
    // structures, not separate instances.
    const isDoubleCountedStructure =
      base.measurementType === "count" &&
      /\b(SSMH|MANHOLE\s+WW|MH\s+WW)\b/i.test(base.name);

    // Detect items that appear on overlapping sheets (site plan + utility plan)
    // and should take MAX, not SUM — the same physical item shown on multiple
    // sheets for reference. Meters, hydrants, and connection points are typical.
    const isOverlappingSheetItem =
      base.measurementType === "count" &&
      /\b(METER\s+BOX|WATER\s+METER|METER\s+CAN|FIRE\s+HYDRANT)\b/i.test(
        base.name
      );

    if (base.measurementType === "count") {
      if (isDoubleCountedStructure || isOverlappingSheetItem) {
        // Same physical item on plan AND profile/utility sheets.
        // Take MAX count, not sum.
        const maxQty = Math.max(...group.map((g) => g.quantity));
        base.quantity = maxQty;
        if (isDoubleCountedStructure) base.confidence = "low";
        const reason = isDoubleCountedStructure
          ? "plan/profile counts"
          : "overlapping sheet counts";
        const note = `Cross-chunk dedup: collapsed ${group.length} ${reason} to max=${maxQty}`;
        base.description = base.description
          ? `${base.description}; ${note}`
          : note;
        console.log(
          `[crossmerge] ${isDoubleCountedStructure ? "SSMH" : "meter/FH"} collapse: "${base.name}" ${group.length} rows → max qty=${maxQty}`
        );
      } else {
        // Default: count items from different sheets sum (e.g. saddles,
        // fittings on multiple plan sheets add up to the project total)
        base.quantity = group.reduce((sum, g) => sum + g.quantity, 0);
      }
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
 * Normalize an item name to a canonical form so typo/synonym variants
 * aggregate correctly. This runs BEFORE exclusion + aggregation.
 *
 * Rules (applied in order):
 *   1. Uppercase + collapse whitespace
 *   2. Fix common plan-set typos (JUNTION → JUNCTION, RDP → RCP)
 *   3. Strip "PROPOSED " prefix (the AI sometimes keeps it from plan callouts)
 *   4. Collapse "ROCK RIP RAP" / "GROUTED ROCK RIP RAP" → "GROUTED RIP RAP"
 *   5. Collapse any duplicate "SD SD" / "W W" / "WW WW" suffixes
 *   6. Strip a single trailing system suffix so " SD" / " W" / " WW" variants aggregate
 */
function normalizeItemName(name: string): string {
  let n = name.toUpperCase().replace(/\s+/g, " ").trim();

  // Typo fixes
  n = n.replace(/\bJUNTION\b/g, "JUNCTION");
  n = n.replace(/\bRDP\b/g, "RCP");
  n = n.replace(/\bHEDWL\b/g, "HEADWALL");
  n = n.replace(/\bPLGU\b/g, "PLUG");

  // Strip "PROPOSED " prefix — the AI adds it inconsistently from plan callouts
  n = n.replace(/^PROPOSED\s+/g, "");

  // Rip rap canonicalization: "GROUTED ROCK RIP RAP" / "ROCK RIP RAP" / "RIP RAP GROUTED"
  n = n.replace(/\bGROUTED\s+ROCK\s+RIP\s+RAP\b/g, "GROUTED RIP RAP");
  n = n.replace(/\bROCK\s+RIP\s+RAP\b/g, "RIP RAP");
  n = n.replace(/\bRIP\s+RAP\s+GROUTED\b/g, "GROUTED RIP RAP");

  // Concrete pilot channel/flume canonicalization (reference uses "CONCRETE PILOT FLUME")
  n = n.replace(/\bCONCRETE\s+PILOT\s+CHANNEL\b/g, "CONCRETE PILOT FLUME");
  n = n.replace(/\b4'?\s+CONCRETE\s+PILOT\s+FLUME\b/g, "CONCRETE PILOT FLUME");

  // Sanitary sewer manhole normalization: "SANITARY SSMH", "SANITARY SEWER
  // MANHOLE", "SEWER MANHOLE" (all without a size prefix) normalize to bare
  // "SSMH". This lets the genericBlacklist logic below detect the name as a
  // suffix of sized variants like "4X11 SSMH" and drop the generic row.
  // Only applies when there is NO size prefix (\d+, \d+X\d+) — sized items
  // like "4X11 SSMH" and "4X5 SANITARY SSMH" keep their specificity.
  n = n.replace(/^SANITARY\s+(SEWER\s+)?(SSMH|MANHOLE)$/g, "SSMH");
  n = n.replace(/^SEWER\s+MANHOLE$/g, "SSMH");

  // Collapse duplicate trailing system suffixes (" SD SD", " W W", " WW WW")
  n = n.replace(/\b(SD|W|WW|DEMO)\s+\1\b/g, "$1");

  // Strip a SINGLE trailing system suffix so "GROUTED RIP RAP SD" and
  // "GROUTED RIP RAP" normalize to the same string. The system is already
  // tracked in item.system — the suffix in the name is redundant noise that
  // prevents aggregation. Requires leading whitespace so bare "SD"/"W"/"WW"
  // (an item literally named just the system) is left alone for other
  // filters to catch. Applied AFTER the duplicate-suffix collapse above.
  n = n.replace(/\s+(SD|W|WW|DEMO)$/, "");

  // Collapse whitespace one more time after all the substitutions
  n = n.replace(/\s+/g, " ").trim();

  return n;
}

/**
 * Merge linear pipe segments that share the same (size, material, system) spec
 * into a single total-length row. The AI often splits one pipe run into
 * multiple rows by storm-line segment name (e.g., "12" RCP SD - STORM LINE 1",
 * "12" RCP SD - STORM LINE 3") which are correct individually but need to be
 * summed for the takeoff. This pass does that summation.
 *
 * Only affects linear (FT) items. Count and area items are left alone.
 * Placeholder rows (qty=0) are passed through unchanged.
 *
 * The pipe spec is extracted via regex: the FIRST occurrence of
 * `<digits>" <MATERIAL>` in the name (e.g., "12" RCP", "6" SDR26", "48" HDPE").
 * Items that don't match the pattern are left as-is.
 */
function mergePipeSegments(items: ExtractedItem[]): ExtractedItem[] {
  const nonLinear: ExtractedItem[] = [];
  const linearBySpec = new Map<string, ExtractedItem[]>();

  for (const item of items) {
    if (item.measurementType !== "linear" || isManualPlaceholder(item)) {
      nonLinear.push(item);
      continue;
    }

    // Extract the pipe spec: e.g. "12" RCP" from "12" RCP SD - STORM LINE 3"
    const specMatch = item.name.match(
      /^(\d+(?:\.\d+)?)\s*["']\s*([A-Z][A-Z0-9/]*)/i
    );
    if (!specMatch) {
      nonLinear.push(item);
      continue;
    }

    const size = specMatch[1];
    const material = specMatch[2].toUpperCase();
    const key = `${size}|${material}|${item.system}`;

    const group = linearBySpec.get(key);
    if (group) group.push(item);
    else linearBySpec.set(key, [item]);
  }

  // For each spec group, sum quantities into one row
  const merged: ExtractedItem[] = [];
  for (const [, group] of linearBySpec) {
    if (group.length === 1) {
      // Single row — keep the name but strip segment suffixes for cleanliness
      const item = group[0];
      const clean = item.name.replace(
        /\s*-?\s*(STORM\s+LINE|STM\s+LINE|SS-|PRIVATE|LATERAL)\s*\S*/gi,
        ""
      ).trim();
      if (clean && clean !== item.name) {
        item.name = clean;
      }
      merged.push(item);
      continue;
    }

    // Multiple rows — sum into one
    // Use the highest-confidence / best-method row as the base
    group.sort((a, b) => {
      const mDiff =
        (METHOD_RANK[b.quantityMethod || ""] ?? 0) -
        (METHOD_RANK[a.quantityMethod || ""] ?? 0);
      if (mDiff !== 0) return mDiff;
      return (
        (CONFIDENCE_RANK[b.confidence] ?? 0) -
        (CONFIDENCE_RANK[a.confidence] ?? 0)
      );
    });

    const base = { ...group[0] };

    // Quality filter: only sum segments with reliable quantities.
    // Station math and explicit callout values are trustworthy.
    // Scale estimates with round numbers (divisible by 5, ≥ 20) are likely
    // guesses and should be excluded from the sum — they inflate the total.
    const isReliableSegment = (g: ExtractedItem): boolean => {
      if (g.quantityMethod === "station_math" || g.quantityMethod === "callout") {
        return true;
      }
      // Non-round small values are probably real callouts even without the method tag
      if (g.quantity > 0 && g.quantity < 20) return true;
      if (g.quantity > 0 && g.quantity % 5 !== 0) return true;
      return false;
    };

    const reliable = group.filter(isReliableSegment);
    const dropped = group.filter((g) => !isReliableSegment(g));

    // If ALL segments are unreliable, fall back to summing everything
    const useGroup = reliable.length > 0 ? reliable : group;
    const totalQty = useGroup.reduce((sum, g) => sum + g.quantity, 0);

    if (dropped.length > 0) {
      console.warn(
        `[pipeMerge] Dropped ${dropped.length} unreliable segment(s): ${dropped
          .map((g) => `${g.name}=${g.quantity}`)
          .join(", ")}`
      );
    }

    // Clean the name — strip segment suffixes to get just "12" RCP"
    const specMatch = base.name.match(
      /^(\d+(?:\.\d+)?)\s*["']\s*([A-Z][A-Z0-9/]*)/i
    );
    if (specMatch) {
      base.name = `${specMatch[1]}" ${specMatch[2].toUpperCase()}`;
    }

    const segmentNames = useGroup.map(
      (g) => `${g.name} (${g.quantity.toFixed(2)})`
    );
    base.quantity = totalQty;
    base.dedupeKey = buildFallbackKey(base);
    base.evidence =
      `Summed ${useGroup.length} pipe segments: ${segmentNames.join(" + ")} = ${totalQty.toFixed(2)} FT` +
      (dropped.length > 0
        ? `. Excluded ${dropped.length} unreliable segment(s): ${dropped.map((g) => `${g.name}=${g.quantity}`).join(", ")}`
        : "") +
      `. ${base.evidence || ""}`;

    // Use the best method from the reliable group
    if (reliable.length > 0) {
      const bestMethod = reliable.reduce((best, cur) => {
        return (METHOD_RANK[cur.quantityMethod || ""] ?? 0) >
          (METHOD_RANK[best.quantityMethod || ""] ?? 0)
          ? cur
          : best;
      });
      base.quantityMethod = bestMethod.quantityMethod;
    }

    console.log(
      `[pipeMerge] Merged ${useGroup.length} segments of "${base.name}" → ${totalQty.toFixed(2)} FT${
        dropped.length > 0 ? ` (dropped ${dropped.length} unreliable)` : ""
      }`
    );

    merged.push(base);
  }

  const totalMerged = items.length - (nonLinear.length + merged.length);
  if (totalMerged > 0) {
    console.log(
      `[pipeMerge] ${items.length} → ${nonLinear.length + merged.length} items (merged ${totalMerged} pipe segments)`
    );
  }

  return [...nonLinear, ...merged];
}

/**
 * Post-processing: apply deterministic name corrections and remove excluded items.
 * This runs AFTER AI extraction and dedup, fixing known systematic AI errors.
 *
 * Pipeline:
 *   1. Normalize names (canonicalize typos, synonyms, prefixes)
 *   2. Apply regex name corrections (AI-specific error patterns)
 *   3. Exclude items matching exclusion patterns (SWPPP, detail sheets, meta)
 *   4. Drop items with physically-impossible specs (non-standard pipe sizes, qty=0 counts)
 *   5. Downgrade confidence on implausible SSMH depths (>20 FT)
 *   6. Suppress generic items when a more-specific version exists
 *   7. Re-aggregate to merge items that became identical after normalization
 */
function postProcessItems(items: ExtractedItem[]): ExtractedItem[] {
  // Standard civil pipe sizes (inches). Anything else is a misread label,
  // station number, or elevation interpreted as a pipe size.
  // Covers water (1-24), sanitary (4-18), and storm drain (12-72).
  const STANDARD_PIPE_SIZES = new Set<number>([
    1, 1.5, 2, 4, 6, 8, 10, 12, 15, 16, 18, 20, 21, 24, 30, 36, 42, 48, 54, 60, 72,
  ]);

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

    // ── PlanSwift name mapping: AI reads what the PLAN says, but PlanSwift ──
    // ── uses different conventions. These mappings align AI output with the ──
    // ── estimator's naming standard based on observed reference takeoffs. ──

    // Water service lines: "DOM. LINE" / "DOM LINE" / "DOM WATER LINE" / "RL LINE" → "POLY"
    { pattern: /\bDOM\.?\s+LINE\b/i, replacement: "POLY" },
    { pattern: /\bDOM\.?\s+WATER\s+LINE\b/i, replacement: "POLY" },
    { pattern: /\bRL\s+LINE\b/i, replacement: "POLY" },
    // Water meters: "DOM METER" / "DOM WATER METER" → "METER BOX ASSY"
    { pattern: /\bDOM\.?\s+WATER\s+METER\b/i, replacement: "METER BOX ASSY" },
    { pattern: /\bDOM\.?\s+METER\b/i, replacement: "METER BOX ASSY" },
    // Irrigation meters: "IRR METER" → "IRR METER BOX ASSY" (when not already "ASSY")
    { pattern: /\bIRR\.?\s+METER(?!\s+BOX)\b/i, replacement: "IRR METER BOX ASSY" },
    // Cleanouts: "CLEANOUT" → "CLEANOUT ASSY" (when not already "ASSY")
    { pattern: /\bCLEANOUT(?!\s+ASSY)\b/i, replacement: "CLEANOUT ASSY" },
    // Catch-all: collapse any double "ASSY ASSY" from multiple mappings stacking
    // (e.g., AI outputs "DOM METER ASSY" → mapping makes "METER BOX ASSY ASSY")
    { pattern: /\bASSY\s+ASSY\b/gi, replacement: "ASSY" },
    // Junction boxes: "JUNCTION BOX W/ ACCESS" → "JB W/ACCESS LID"
    { pattern: /\bJUNCTION\s+BOX\s+W\/?\s*ACCESS\b/i, replacement: "JB W/ACCESS LID" },
    // Stubout connections: "DOM STUBOUT CONNECTION" → strip to just the item
    { pattern: /\bDOM\s+STUBOUT\s+CONNECTION\b/i, replacement: "STUBOUT CONNECTION" },
    // Water PLUG → CAP: PlanSwift convention uses "CAP" not "PLUG" for water dead-ends
    { pattern: /\bPLUG\s+WATER\s+W\b/i, replacement: "CAP WATER W" },
    { pattern: /\bPLUG\s+WATER\b/i, replacement: "CAP WATER" },
    { pattern: /\bPLUG\s+W\b$/i, replacement: "CAP W" },
    // Sewer manhole naming: "SSMH" is fine but some AI outputs just "SEWER MANHOLE"
    { pattern: /\bSEWER\s+MANHOLE\b/i, replacement: "SSMH" },
    // Strip garbled trailing words from ASSY names: "METER BOX ASSY CAN" → "METER BOX ASSY"
    { pattern: /\bASSY\s+(CAN|BOX|SET|KIT|UNIT)\s*$/i, replacement: "ASSY" },
    // Non-standard bend angles → flag as likely misread. Standard: 11.25, 22.5, 30, 45, 90.
    // "32 BEND" is almost certainly a misread of "31.99%" slope. Map to closest standard.
    { pattern: /\b32\s+BEND\b/i, replacement: "30 BEND" },
    { pattern: /\b46\s+BEND\b/i, replacement: "45 BEND" },
    { pattern: /\b23\s+BEND\b/i, replacement: "22.5 BEND" },
    { pattern: /\b12\s+BEND\b/i, replacement: "11.25 BEND" },
    { pattern: /\b91\s+BEND\b/i, replacement: "90 BEND" },
  ];

  // ── Exclusion patterns: items that should not be in utility takeoffs ──
  const EXCLUSION_PATTERNS: RegExp[] = [
    // SWPPP / erosion control (existing)
    /SWPPP/i,
    /SILT\s*FENCE/i,
    /CONSTRUCTION\s*ENTRANCE/i,
    /WASHOUT/i,
    /INLET\s*PROTECTION/i,
    /EROSION\s*(BLANKET|CONTROL)/i,
    /CHECK\s*DAM/i,
    /FIBER\s*ROLL/i,
    /WATTLE/i,
    /^[12]"\s*(PLUG|VALVE)\s+W$/i, // Small service plugs/valves
    // NOTE: the old /^6"\s*PLUG/i exclusion was removed — 6" PLUG WATER W is a
    // legitimate takeoff item (dead-end caps on 6" water mains) and the
    // reference list proves it.

    // Meta / reference-only entries the AI sometimes emits
    /-\s*NO\s+MEASURABLE\s+QUANTIT/i,
    /-\s*NO\s+EXTRACTABLE/i,
    /-\s*REFERENCE\s+ONLY/i,
    /-\s*INFORMATIONAL\s+ONLY/i,
    /NOTES?\s+SHEET\s+ONLY/i,
    /HYDRAULIC\s+CALC\s+SHEET/i,
    /STANDARD\s+DETAILS?\s*$/i,
    /\bNCTCOG\s+STANDARD/i,
    /DRAINAGE\s+AREA\s+MAP/i,

    // Manhole DETAIL sheet labels (not actual project items)
    // These come from reading detail-sheet titles like "WASTEWATER MANHOLE - PRECAST"
    // rather than counting physical manholes. Real manholes in the takeoff are named
    // "4X5 SSMH WW", "4X9 SSMH WW", etc. — with a size prefix.
    /^WASTEWATER\s+MANHOLE\s+(PRECAST|FIBERGLASS|CAST[- ]IN[- ]PLACE|VENTED|PRESSURE[- ]TYPE|INVERT\s+DETAIL|INSIDE\s+DROP|OUTSIDE\s+DROP)/i,
    /^WASTEWATER\s+ACCESS\s+DEVICE/i,
    /^WASTEWATER\s+LATERAL\s+CONNECTION/i,
    /^WASTEWATER\s+MAIN\s+TIE[- ]IN/i,
    /^STORM\s+DRAIN\s+PIPE\s+CONNECTION/i,

    // Easement callouts (scope markers, not construction items).
    // Note: NO $ end-anchors because names often have trailing junk like
    // " (PRIV)", " SD", " (PVMT)", or trailing system suffixes. Use \b
    // word-boundary matches that fire anywhere the phrase appears.
    /\bUTILITY\s+(EASEMENT|ESMT)\b/i,
    /\bCOMMON\s+AREA\s+DRAINAGE\s+(EASEMENT|ESMT)\b/i,
    /\bSANITARY\s+SEWER\s+EASEMENT\b/i,
    /\bDRAINAGE\s+(EASEMENT|ESMT)\b/i,
    /\bWATER\s+EASEMENT\b/i,
    /\bFIRE\s+LANE\s+ACCESS\s+UTILITY\s+DRAINAGE/i, // FUAD/FLAUD easement callouts
    /\bDETENTION[\/ ]DRAINAGE\s+EASEMENT/i,
    /\bSURVEY\s+BOUNDARY/i,

    // Physically impossible pipe sizes (> 72")
    /^\s*(\d{3,})"\s+(RCP|HDPE|PVC|DIP|CIP)/i, // any 3+ digit pipe size
    // RDP (typo) is handled by normalization, but catch any stragglers
    /\bRDP\b/i,

    // Any remaining standalone "DETAIL" entries (often sheet references)
    /\bDETAIL\s*$/i,

    // ── Site / roadway / landscape scope (NOT water utility takeoff) ──
    // Curbs and curb transitions
    /\bMOUNTABLE\s+CURB\b/i,
    /^CONC\s+[0-9]+['"]?\s+MOUNTABLE\s+CURB/i,
    /^[0-9]+['"]?\s*CURB(\s+WALL)?\s*(W|SD|WW)?$/i, // "5' CURB W", "CURB", "CURB WALL", "6" CURB"
    /^CURB(\s+WALL)?$/i,                              // bare "CURB" / "CURB WALL"
    /\bTRANSITION\s+FROM.+CURB/i,
    /\bEND\s+CURB\s+WALL\b/i,
    /\bCURB\s+OPENING\b/i, // "3\" CURB OPENING", "5' CURB OPENING" (not a utility item)

    // Pavement types (site paving scope, not utility)
    /^HEAVY\s+DUTY\s+PAVEMENT/i,
    /^MEDIUM\s+DUTY\s+PAVEMENT/i,
    /^LIGHT\s+DUTY\s+PAVEMENT/i,
    /^INDUSTRIAL\s+PAVEMENT/i,
    /^SIDEWALK\s+PAVEMENT/i,
    /^REMOVE\s+AND\s+REPLACE\s+EXISTING\s+PAVEMENT/i,
    /^REMOVE\/REPLACE\s+CONCRETE\s+OTHER/i,

    // Signage / parking / landscape
    /\bADA\s+SIGN\b/i,
    /^SIGN\s*$/i,
    /^PROPOSED\s+SIGN\b/i,
    /\bPARKING\s+SPACES?\b/i,
    /\bLANDSCAPE\b/i,

    // Grading scope markers
    /\bTOE\s+OF\s+SLOPE\b/i,
    /\bSWALE\b/i,
    /\bROADWAY\s+DITCH/i,
    /\bTRAPEZOIDAL\s+DITCH\b/i,
    /\bRETAINING\s+WALL\b/i,
    /\bFIRE\s+LANE\s+ACCESS/i,

    // Demolition scope (separate takeoff — not water utility)
    /\bEX\.\s+HOUSE\b/i,
    /\bEXISTING\s+HOUSE\b/i,
    /\bMH\s*\(TO\s+BE\s+REMOVED\)/i,

    // "BY OTHERS" scope (separate contractor, not in our takeoff)
    /\bSEPTIC\s+(TANK|FIELD)\b.*BY\s+OTHERS/i,
    /\(BY\s+OTHERS\)/i,
    /\bWATER\s+WELL\b/i, // water wells are usually BY OTHERS

    // Survey / reference monuments
    /\bRF\s*\(BURKS/i, // survey monument "1/2\" RF (BURKS 5009)"
    /\bSTEEL\s+POST\b/i,

    // Generic scope markers / connection points (not countable items)
    /\bSTM\s+LAT\s+CONNECTION\b/i,
    /\bINSTALL\s+WYE\b/i, // generic wye with no size — filtered so AI rewrites it with a size
    /\bDETENTION\s+POND\b/i, // scope marker
    /\bWATER\s+CROSSING\b/i, // crossing marker

    // Septic fields (private system, not water utility)
    /^SEPTIC\s+FIELD\b/i,

    // ── Irrigation / landscape scope (L-series, NOT water utility) ──
    // Sonnet sometimes extracts from landscape/irrigation plan sheets.
    // These are completely out of scope for water utility takeoffs.
    /\bIRRIGATION\b/i,
    /\bDRIP\s*LINE\b/i,    // "DRIPLINE" or "DRIP LINE"
    /\bDRIP\s+CONTROL\b/i,
    /\bROTATOR\s+HEAD\b/i,
    /\bSPRINKLER\b/i,
    /\bHUNTER\s+(MP|ICV|ICZ|ECO|WSS|I2C|DRIPLINE|PRO|HDL)/i,
    /\bNETAFIM\b/i,
    /\bRAIN\s*BIRD\b/i,
    /\bFEBCO\b/i,
    /\bQUICK\s+COUPLING\s+VALVE\b/i,
    /\bRAIN[\/ ]FREEZE\s+SENSOR\b/i,
    /\bPRESSURE\s+SENSOR\b/i,
    /\bFLUSH\s+VALVE\b.*\b(NETAFIM|DRIP|TLSOV)\b/i,
    /\bWYE\s+STRAINER\b/i,
    /\bPIPE\s+TRANSITION\s+POINT\b/i,  // irrigation above-grade transitions
    /\bIRR\.\s+(LINE|LATERAL|WATER)/i,
    /\bCLASS\s+200\s+SDR\s+21\b/i,
    /\bCONTROLLER\b.*\b(HUNTER|RAIN\s*BIRD|TORO)\b/i,
    /\bBALL\s+VALVE\b/i,   // ball valves are irrigation, not water utility (utility uses gate valves)
    /\bEND\s+CAP\s+FLUSH\b/i,
    /\bCONNECT\s+TO\s+EX\.\s+SIDEWALK\b/i,  // site work, not utility
    // Additional irrigation patterns — GPT-5.4 reads L-series schedule tables
    /\bCONTROL\s+VALVE\b/i,          // irrigation remote control valve
    /\bQUICK\s+COUPLER\b/i,          // alt spelling of quick coupling valve
    /\bDOUBLE\s+CHECK\s+BACKFLOW\b/i, // irrigation backflow preventer (Febco 850, etc.)
    /\bCLASS\s+200\b/i,              // irrigation PVC spec (Class 200 SDR21)
    /\bSDR\s*21\b/i,                  // irrigation lateral pipe rating
    /\bPVC\s+CLASS\b/i,              // "PVC Class 200" in any order
    /\bLATERAL\s+LINE\b/i,           // irrigation lateral line from schedule
    // Meta-placeholder safety net — AI sometimes emits items describing the PDF
    // status ("no civil sheets provided") when processing a chunk that only
    // contains detail/landscape sheets. These must never reach the inventory.
    /CIVIL\s+UTILITY\s+PLAN\s+SHEETS?/i,
    /NO\s+CIVIL\s+SHEETS?/i,
    /PLAN\s+SET\s+CONTAINS/i,
    /SHEETS?\s+NOT\s+PROVIDED/i,
    /MISSING\s+SHEETS?/i,
    /MISSING\s+PROFILE\s+SHEETS?/i,
    /INCOMPLETE\s+PLAN\s+SET/i,
    /REQUEST\s+COMPLETE\s+PLAN\s+SET/i,
    // BFR = Barrier-Free Ramp (ADA curb ramp) on civil site plans — NOT a utility
    // item and NOT a backflow preventer. AI sometimes misreads "BFR" as "Backflow
    // Preventer" because of the abbreviation overlap. Always exclude.
    /\bINSTALL\s+BFR\b/i,
    /\bBARRIER[- ]FREE\s+RAMP\b/i,
    // "CONNECT TO EXISTING..." callouts are NOTES describing how new work ties
    // into existing utilities — they are not countable items. The actual work
    // (tapping sleeve, cut-in tee, etc.) is counted as its own item if present.
    /^CONNECT\s+TO\s+EXISTING\b/i,

    // ── Electrical scope (NOT water utility) ──
    // AI sometimes reads electrical site-plan callouts and extracts conduits,
    // transformers, pull boxes, etc. These belong to an electrical takeoff,
    // not a civil/water-utility one.
    /\(ELECTRICAL\)/i,
    /\bPAD[- ]MOUNT(ED)?\s+TRANSFORMER\b/i,
    /\bTRANSFORMER\b/i,
    /\bINSTALL\s+PULL\s+BOX\b/i,
    /\bPULL\s+BOX\b/i,
    /\bMETER\s+BASE\b/i,
    /\bSTANDOFF\s+BRACKETS?\b/i,
    /\bSCHEDULE\s+40\s+PVC\s+CONDUIT\b/i,
    /\bSCH(ED)?\.?\s*40\s+(PVC|ELECTRICAL)\s+CONDUIT\b/i,

    // ── Generic-name meta-placeholders (not real items) ──
    // AI sometimes emits rollup/summary rows with generic names instead of
    // actual sized items. These are always placeholders for real data that
    // either got extracted separately or was never measurable.
    /^STORM\s+DRAIN\s+PIPE\s+(SD|CALLOUTS|LABELS)\b/i,
    /^STORM\s+DRAIN\s+PIPE\s*$/i,
    /^STORM\s+DRAIN\s+STRUCTURE\b/i,
    /^STORM\s+DRAIN\s+CALLOUTS?/i,
    /^WATER\s+LINE\s+CALLOUTS?/i,
    /^SEWER\s+LINE\s+CALLOUTS?/i,

    // ── LINE A / LINE B sum rows ──
    // AI sometimes emits summary rows like "STORM DRAIN PIPE LINE A" that
    // total up all the individual pipe sizes on a given line — these
    // duplicate the per-size rows already extracted from the hydraulic table.
    /^STORM\s+DRAIN\s+PIPE\s+LINE\s+[A-Z]\b/i,
    /^LINE\s+[A-Z]\s+(TOTAL|SUM|STORM)/i,
    /^(STORM|PIPE)\s+LINE\s+[A-Z]\s*(TOTAL|SUM)?/i,
  ];

  // Also drop generic residuals when a more-specific version exists in the
  // same system+measurementType bucket. Populated below from the actual data.
  const genericBlacklist = new Set<string>();

  // First pass: collect all normalized names per bucket so we can find generics
  const namesByBucket = new Map<string, Set<string>>();
  for (const it of items) {
    const bucket = `${it.measurementType}|${it.system}`;
    const norm = normalizeItemName(it.name);
    if (!namesByBucket.has(bucket)) namesByBucket.set(bucket, new Set());
    namesByBucket.get(bucket)!.add(norm);
  }

  // For each bucket, find names that are a strict suffix of another name.
  // E.g., "HEADWALL SD" is a suffix of "30\" TXDOT HEADWALL SD" → generic.
  // "GATE VALVE W" is a suffix of "6\" GATE VALVE W" → generic.
  // Only match when the prefix adds a size spec like 4", 4', 4X4, or a
  // qualifier word — never strip a name entirely.
  for (const names of namesByBucket.values()) {
    const list = Array.from(names);
    for (const candidate of list) {
      for (const other of list) {
        if (other === candidate) continue;
        if (!other.endsWith(" " + candidate)) continue;
        // The prefix must look like a size or qualifier, not a random word
        const prefix = other.slice(0, other.length - candidate.length - 1);
        if (/^(\d+['"]?|\d+X\d+|\d+\.\d+['"]?|CAST\s+IN\s+PLACE|TXDOT|TYPE\s+[A-Z]|PRECAST|GROUTED|\d+['"]?\s+TXDOT|\d+['"]?\s+TYPE\s+[A-Z])\b/i.test(
            prefix
          )
        ) {
          genericBlacklist.add(candidate);
          break;
        }
      }
    }
  }

  const result: ExtractedItem[] = [];
  let normalizedCount = 0;
  let excludedCount = 0;
  let genericDropped = 0;
  let placeholdersPreserved = 0;
  let scaleNoiseDemoted = 0;

  // Track which placeholder categories are already present so we don't
  // synthesize duplicates later.
  const presentPlaceholderKeys = new Set<string>();

  for (const item of items) {
    // 0. PLACEHOLDER FAST PATH — Tier 3 manual-measurement rows bypass
    //    normalization, exclusion, and dedup. They are passed through
    //    as-is so the "- MEASURE MANUALLY" suffix survives intact and the
    //    inventory UI can detect them.
    if (isManualPlaceholder(item)) {
      placeholdersPreserved++;
      // Ensure placeholder has a dedupe key we can match on later
      const baseName = item.name.slice(
        0,
        item.name.length - MANUAL_MEASURE_SUFFIX.length
      );
      if (!item.dedupeKey) {
        item.dedupeKey = `${baseName.toUpperCase()}|placeholder`;
      }
      presentPlaceholderKeys.add(baseName.toUpperCase());
      result.push(item);
      continue;
    }

    // 0b. L-SERIES LANDSCAPE SHEET FILTER — skip items sourced from
    //     landscape/irrigation sheets (L-5, L-6, etc.). GPT-5.4 aggressively
    //     reads irrigation schedule tables that are out of scope.
    //     Exception: irrigation meter boxes are water utility scope.
    if (item.sourceSheetId && /^L[-\s]?\d/i.test(item.sourceSheetId)) {
      if (!/IRR.*METER/i.test(item.name)) {
        excludedCount++;
        console.log(`[postprocess] Excluded (landscape sheet ${item.sourceSheetId}): ${item.name}`);
        continue;
      }
    }

    // 0c. EXISTING UTILITY FILTER — skip items that reference existing ("Ex.")
    //     infrastructure, not new work. GPT-5.4 sometimes extracts "Ex. 8" PVC"
    //     as new pipe.
    const nameUpper = item.name.toUpperCase();
    if (
      /\bEX\.?\s+\d/i.test(item.name) ||
      /^EXIST/i.test(item.name) ||
      nameUpper.startsWith("EX. ") ||
      nameUpper.startsWith("EX ")
    ) {
      excludedCount++;
      console.log(`[postprocess] Excluded (existing utility): ${item.name}`);
      continue;
    }
    // Also check evidence for "Ex." prefix on pipe segments
    if (
      item.measurementType === "linear" &&
      item.evidence &&
      /\bEX\.?\s+\d+(?:\.\d+)?['"]\s+(RCP|HDPE|PVC|DIP|POLY)/i.test(item.evidence) &&
      !item.evidence.toLowerCase().includes("connect to ex")
    ) {
      // If the evidence references existing pipe AND the item has no other
      // new-work segments, flag it
      const hasNewSegments = /\d+\s*LF\s+OF\s+\d/i.test(item.evidence) ||
        /STA\s+\d\+/i.test(item.evidence);
      if (!hasNewSegments) {
        excludedCount++;
        console.log(`[postprocess] Excluded (evidence references existing pipe): ${item.name}`);
        continue;
      }
    }

    // 1. Normalize name
    const normalized = normalizeItemName(item.name);
    if (normalized !== item.name) {
      normalizedCount++;
      item.name = normalized;
    }

    // 2. Apply regex name corrections
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

    // 3. Self-flagged duplicates: AI sometimes emits a row AND flags it as a
    // dup in its own description or evidence. Drop these — the AI told us.
    const selfDupPattern = /\b(duplicate entry|already counted|disregard|duplicate of)\b/i;
    const selfDupText = `${item.description || ""} ${item.evidence || ""}`;
    if (selfDupPattern.test(selfDupText)) {
      excludedCount++;
      console.log(`[postprocess] Dropped self-flagged duplicate: "${item.name}"`);
      continue;
    }

    // 4. Exclusion patterns
    if (EXCLUSION_PATTERNS.some((p) => p.test(item.name))) {
      excludedCount++;
      console.log(`[postprocess] Excluded (detail/meta): ${item.name}`);
      continue;
    }

    // 4. Impossible quantities — drop count items with qty=0
    if (item.measurementType === "count" && (!item.quantity || item.quantity <= 0)) {
      excludedCount++;
      console.log(`[postprocess] Excluded (qty=0 count): ${item.name}`);
      continue;
    }

    // 5. Non-standard pipe size filter. Match names that look like pipe
    // specs (number followed by material) and drop if the size isn't in the
    // standard set. Handles K COPPER via the optional prefix-word group.
    // Runs AFTER normalization so names are uppercased.
    const pipeMatch = item.name.match(
      /^(\d+(?:\.\d+)?)["']\s+(?:[A-Z]+\s+)?(RCP|HDPE|PVC|DIP|DR\d+|SDR\d+|POLY|COPPER)\b/i
    );
    if (pipeMatch) {
      const size = parseFloat(pipeMatch[1]);
      if (!STANDARD_PIPE_SIZES.has(size)) {
        excludedCount++;
        console.log(
          `[postprocess] Excluded (non-standard pipe size ${size}"): ${item.name}`
        );
        continue;
      }
    }

    // 6. SCALE ESTIMATE NOISE DEMOTION (Tier 3 conversion).
    //    Items with quantityMethod=scale_estimate are systematically unreliable.
    //    Convert obvious noise into Tier 3 placeholders so the human can
    //    measure them properly:
    //      - Area items > 500 SQ FT from scale_estimate (always noisy)
    //      - Linear items > 500 FT from scale_estimate (network traces fail)
    //      - Suspicious round-number scale_estimate values ≥ 100
    //    The prompt already asks Opus to emit these as placeholders, but if
    //    it tried to estimate anyway, we demote here.
    if (item.quantityMethod === "scale_estimate") {
      const isNoisyArea =
        item.measurementType === "area" && item.quantity > 500;
      const isNoisyLinear =
        item.measurementType === "linear" && item.quantity > 500;
      const isSuspiciousRound =
        item.quantity >= 100 && item.quantity % 50 === 0;

      if (isNoisyArea || isNoisyLinear || isSuspiciousRound) {
        scaleNoiseDemoted++;
        console.warn(
          `[postprocess] Demoted to Tier 3 placeholder: "${item.name}" qty=${item.quantity} (reason: ${
            isNoisyArea ? "noisy area scale_estimate" : isNoisyLinear ? "noisy linear scale_estimate" : "suspicious round number"
          })`
        );
        // Replace in place with a Tier 3 placeholder — keep the same name
        // but strip any system suffix and append the magic marker
        const baseName = item.name.replace(/\s+-\s+MEASURE\s+MANUALLY$/i, "");
        item.name = baseName + MANUAL_MEASURE_SUFFIX;
        item.quantity = 0;
        item.confidence = "low";
        item.dedupeKey = `${baseName.toUpperCase()}|placeholder`;
        item.evidence =
          `MEASURE MANUALLY: AI produced an unreliable ${item.measurementType} scale_estimate (original: ${
            isNoisyArea || isNoisyLinear ? item.quantity.toFixed(2) : item.quantity
          }). ${item.evidence ?? ""}`.trim();
        presentPlaceholderKeys.add(baseName.toUpperCase());
        result.push(item);
        continue;
      }
    }

    // 7. SSMH depth sanity check. Gravity sewer manholes in commercial
    // subdivision projects are typically 4-15 FT deep. Depths over 20 FT
    // almost always mean the AI misread the RIM or FL elevation on the
    // profile sheet. Don't drop — downgrade confidence and annotate so
    // the human reviewer can verify.
    const ssmhMatch = item.name.match(/^(\d+)X(\d+(?:\.\d+)?)\s+SSMH/i);
    if (ssmhMatch) {
      const depth = parseFloat(ssmhMatch[2]);
      if (depth > 20) {
        console.warn(
          `[postprocess] SSMH depth ${depth} FT is implausible — downgrading confidence: ${item.name}`
        );
        item.confidence = "low";
        const note = `Depth ${depth} FT is implausibly deep — verify RIM−FL reading from profile sheet`;
        item.description = item.description
          ? `${item.description}; ${note}`
          : note;
      }
    }

    // 8. Slope-as-length detection. Profile callouts like "18" RCP @ 31.99%"
    //    sometimes cause the AI to store the slope percentage as the pipe
    //    length. Detect when a linear item's quantity suspiciously matches a
    //    slope percentage from its own evidence text and flag it.
    if (
      item.measurementType === "linear" &&
      item.quantity > 0 &&
      item.quantity < 50 &&
      item.evidence
    ) {
      // Check if the quantity appears as a slope percentage in the evidence
      const qtyStr = item.quantity.toFixed(2).replace(/\.?0+$/, "");
      const slopePattern = new RegExp(
        `@\\s*${qtyStr.replace(".", "\\.")}\\s*%`,
        "i"
      );
      if (slopePattern.test(item.evidence)) {
        console.warn(
          `[postprocess] Slope-as-length detected: "${item.name}" qty=${item.quantity} matches slope ${qtyStr}% — converting to placeholder`
        );
        // Convert to placeholder instead of just downgrading — a slope value
        // as pipe length is always wrong, never "approximately right"
        item.quantity = 0;
        item.confidence = "low";
        item.quantityMethod = "scale_estimate";
        if (!item.name.endsWith(MANUAL_MEASURE_SUFFIX)) {
          item.name = `${item.name}${MANUAL_MEASURE_SUFFIX}`;
        }
        const note = `Quantity was ${qtyStr} which matches slope percentage (${qtyStr}%) in evidence — zeroed out for manual measurement`;
        item.description = item.description
          ? `${item.description}; ${note}`
          : note;
        item.evidence = `MEASURE MANUALLY: slope-as-length detected. Original evidence: ${item.evidence}`;
      }
    }

    // 9. Generic-version suppression
    // NOTE: blacklist is populated using normalizeItemName() results (see
    // namesByBucket loop above), so the check must also normalize to match.
    // Previously this compared the raw item.name, which missed any item
    // whose name gets rewritten by normalizeItemName (e.g. "SANITARY SSMH"
    // normalizes to "SSMH", but the raw name never matched the blacklist).
    if (genericBlacklist.has(normalizeItemName(item.name))) {
      genericDropped++;
      console.log(`[postprocess] Dropped generic (specific version exists): ${item.name}`);
      continue;
    }

    result.push(item);
  }

  if (
    normalizedCount > 0 ||
    excludedCount > 0 ||
    genericDropped > 0 ||
    placeholdersPreserved > 0 ||
    scaleNoiseDemoted > 0
  ) {
    console.log(
      `[postprocess] normalized=${normalizedCount} excluded=${excludedCount} generics=${genericDropped} placeholders=${placeholdersPreserved} scaleDemoted=${scaleNoiseDemoted} (${items.length} → ${result.length})`
    );
  }

  // ── Sewer bend + cleanout dedup ──
  // When plan callouts say "INSTALL: 1-6" 45 HORZ. BEND AND CLEANOUT", the AI
  // sometimes extracts BOTH "6" CLEANOUT ASSY WW" AND "6" 45 BEND SEWER WW"
  // from the same callout. The bend is a COMPONENT of the assembly, not a
  // separate fitting. Remove same-size sewer bends when cleanout assemblies
  // exist at that size (same pattern as WYE + CLEANOUT rule).
  const sewerCleanoutSizes = new Set<string>();
  for (const it of result) {
    if (
      it.measurementType === "count" &&
      /CLEANOUT\s*ASSY/i.test(it.name) &&
      /WW|wastewater|sewer/i.test(it.system || it.name)
    ) {
      const sizeMatch = it.name.match(/^(\d+(?:\.\d+)?)["']/);
      if (sizeMatch) sewerCleanoutSizes.add(sizeMatch[1]);
    }
  }
  if (sewerCleanoutSizes.size > 0) {
    const beforeCount = result.length;
    const dedupResult: ExtractedItem[] = [];
    for (const it of result) {
      const isSewerBend =
        it.measurementType === "count" &&
        /\bBEND\b/i.test(it.name) &&
        /WW|wastewater|sewer/i.test(it.system || it.name) &&
        !/HDPE|HORZ/i.test(it.name);
      if (isSewerBend) {
        const sizeMatch = it.name.match(/^(\d+(?:\.\d+)?)["']/);
        if (sizeMatch && sewerCleanoutSizes.has(sizeMatch[1])) {
          console.log(
            `[postprocess] Dropped "${it.name}" (qty=${it.quantity}) — component of same-size CLEANOUT ASSY`
          );
          continue;
        }
      }
      dedupResult.push(it);
    }
    if (dedupResult.length < beforeCount) {
      result.length = 0;
      result.push(...dedupResult);
    }
  }

  // ── Heuristic placeholders: auto-detect missing items ──

  // A. HDPE bend placeholders: If HDPE storm pipe exists but zero HDPE bends
  //    were extracted, auto-add placeholder bend items. HDPE bends are the #1
  //    missed item across ALL AI providers — the small callout labels are
  //    unreadable at native PDF resolution.
  const hasHdpePipe = result.some(
    (it) =>
      it.measurementType === "linear" &&
      /HDPE/i.test(it.name) &&
      /SD|storm/i.test(it.system || it.name)
  );
  const hasHdpeBends = result.some(
    (it) =>
      it.measurementType === "count" &&
      /HDPE/i.test(it.name) &&
      (/BEND/i.test(it.name) || /\b(45|90)\b/.test(it.name))
  );
  if (hasHdpePipe && !hasHdpeBends) {
    console.log(
      `[postprocess] Auto-adding HDPE bend placeholders (HDPE pipe found but 0 bends)`
    );
    const bendBase = {
      measurementType: "count" as const,
      system: "storm_drain",
      quantity: 0,
      unit: "EA",
      confidence: "low" as const,
      quantityMethod: "scale_estimate",
    };
    result.push({
      ...bendBase,
      name: `HDPE 90 BEND SD${MANUAL_MEASURE_SUFFIX}`,
      evidence:
        "MEASURE MANUALLY: HDPE storm pipe extracted but zero 90° bends found. Every HDPE pipe direction change requires a bend fitting — count from plan view.",
      dedupeKey: "HDPE 90 BEND SD|placeholder",
    } as ExtractedItem);
    result.push({
      ...bendBase,
      name: `HDPE 45 BEND SD${MANUAL_MEASURE_SUFFIX}`,
      evidence:
        "MEASURE MANUALLY: HDPE storm pipe extracted but zero 45° bends found. Check every HDPE pipe deflection point for bend fittings.",
      dedupeKey: "HDPE 45 BEND SD|placeholder",
    } as ExtractedItem);
  }

  // B. 4" sewer lateral placeholder: If cleanout assemblies exist but no 4"
  //    sewer pipe was extracted, the laterals are missing. Each cleanout has
  //    a corresponding 4" lateral pipe to the building/lot.
  const hasCleanouts = result.some(
    (it) =>
      it.measurementType === "count" &&
      /CLEANOUT\s*ASSY/i.test(it.name) &&
      /WW|wastewater|sewer/i.test(it.system || it.name)
  );
  const has4Pipe = result.some(
    (it) =>
      it.measurementType === "linear" &&
      /^4["']?\s*(SDR|PVC)/i.test(it.name) &&
      /WW|wastewater|sewer/i.test(it.system || it.name)
  );
  if (hasCleanouts && !has4Pipe) {
    console.log(
      `[postprocess] Auto-adding 4" sewer lateral placeholder (cleanouts found but no 4" pipe)`
    );
    result.push({
      name: `4" SDR26 WW${MANUAL_MEASURE_SUFFIX}`,
      measurementType: "linear",
      system: "wastewater",
      quantity: 0,
      unit: "FT",
      confidence: "low",
      quantityMethod: "scale_estimate",
      evidence:
        "MEASURE MANUALLY: cleanout assemblies extracted but zero 4\" sewer lateral pipe found. Each cleanout connects to a 4\" lateral — measure from plan/profile.",
      dedupeKey: '4" SDR26 WW|placeholder',
    } as ExtractedItem);
  }

  // ── Second aggregation pass after normalization + corrections ──
  // Name changes may have created new duplicates (e.g., "GROUTED ROCK RIP RAP" +
  // "GROUTED RIP RAP" both normalized to "GROUTED RIP RAP").
  return aggregateItems(result);
}

/**
 * Detect whether an error is a rate-limit / overload / capacity error
 * that may resolve by waiting. Covers all three providers:
 *   - HTTP 429 (all providers — rate limit)
 *   - HTTP 503 (Gemini service unavailable)
 *   - HTTP 529 (Anthropic overloaded)
 *   - gRPC RESOURCE_EXHAUSTED (Gemini)
 *   - Message patterns: "RATE_LIMIT", "overloaded", "high demand", "capacity"
 */
function isRateLimitOrOverloadError(error: unknown): boolean {
  const errObj = error as Record<string, unknown>;
  const status = errObj?.status;
  if (status === 429 || status === 503 || status === 529) return true;

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("503") ||
      msg.includes("rate_limit") ||
      msg.includes("rate limit") ||
      msg.includes("resource_exhausted") ||
      msg.includes("overloaded") ||
      msg.includes("high demand") ||
      msg.includes("capacity")
    );
  }
  return false;
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

  // ── Chunk processing concurrency ──
  // Each chunk holds the full base64 PDF (~28 MB) plus the AI request body
  // (~same) plus the response JSON plus intermediate state. Running 2 in
  // parallel on a 100+ MB civil plan OOMs V8's zone allocator before it
  // even gets through splitting — observed repeatedly on Fairway Plaza
  // (109 MB / 59 pages).
  //
  // Set to 1 (sequential) to halve peak memory pressure. This trades a bit
  // of wall-clock time (chunks run back-to-back instead of 2 at a time) for
  // reliability on large PDFs. For a 10-chunk extraction at ~30s/chunk this
  // adds ~2-3 min total, but the alternative is crashing and delivering
  // zero items.
  //
  // Override via CHUNK_CONCURRENCY env var if needed.
  const envConcurrency = parseInt(process.env.CHUNK_CONCURRENCY || "", 10);
  const CHUNK_CONCURRENCY = Number.isFinite(envConcurrency) && envConcurrency > 0
    ? envConcurrency
    : 1;

  // Inner function: process a single chunk (extract + verify + retry).
  // Returns items to add to allItems, or records a failure.
  const processChunk = async (i: number): Promise<{
    items: ExtractedItem[];
    summary: string | null;
    failed: boolean;
    failedLabel?: string;
  }> => {
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
      const chunkSummary = result.summary || null;
      console.log(
        `[chunked] Chunk ${i + 1} (${label}): extracted ${result.items.length} item(s)`
      );

      // ── Diagnostic warning: chunks that return suspiciously few items ──
      // A civil plan chunk covering 5+ pages should virtually always
      // produce more than a few items. If it returns 0-2, the AI likely
      // didn't recognize those pages as extractable — flag in logs so
      // gaps like "entire water utility plan missed" become visible.
      const pageCountMatch = label.match(/pages\s+(\d+)-(\d+)/i);
      if (pageCountMatch) {
        const pageCount = parseInt(pageCountMatch[2], 10) - parseInt(pageCountMatch[1], 10) + 1;
        if (pageCount >= 5 && result.items.length <= 2) {
          console.warn(
            `[chunked] ⚠️ Chunk ${i + 1} (${label}, ${pageCount} pages) returned only ${result.items.length} item(s) — possible extraction gap. Check that water/sewer utility sheets weren't missed.`
          );
        }
      }

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
            // In parallel mode, other chunks' items aren't in allItems yet —
            // cross-chunk additions dedup happens in post-merge aggregation.
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

          console.log(
            `[chunked] Chunk ${i + 1} verified: ${verifiedItems.length} items (was ${result.items.length})`
          );
          return { items: verifiedItems, summary: chunkSummary, failed: false };
        } catch (verifyError) {
          console.warn(
            `[chunked] Chunk ${i + 1} verification failed, using unverified items:`,
            verifyError instanceof Error
              ? verifyError.message
              : verifyError
          );
          return { items: result.items, summary: chunkSummary, failed: false };
        }
      } else {
        return { items: result.items, summary: chunkSummary, failed: false };
      }
    } catch (chunkError) {
      const errMsg =
        chunkError instanceof Error ? chunkError.message : String(chunkError);
      const errObj = chunkError as Record<string, unknown>;

      // ── Rate-limit / overload: one extra chunk-level retry ──
      // The provider already retried 3× (up to ~270s total).
      // Give one more attempt with a longer cooldown before skipping.
      if (isRateLimitOrOverloadError(chunkError)) {
        const CHUNK_RETRY_WAIT_SEC = 180;
        console.warn(
          `[chunked] Chunk ${i + 1} (${label}) hit rate limit after provider retries. ` +
            `Waiting ${CHUNK_RETRY_WAIT_SEC}s for chunk-level retry...`
        );

        // Update progress so the user sees the wait in the UI
        if (onProgress) {
          onProgress(
            i,
            pdfChunks.length,
            `${label} — rate limited, retrying in ${CHUNK_RETRY_WAIT_SEC}s...`
          );
        }

        await new Promise((resolve) =>
          setTimeout(resolve, CHUNK_RETRY_WAIT_SEC * 1000)
        );

        try {
          const retryResult = await provider.extractFromPDF(
            pdfChunks[i],
            userPrompt,
            onRetry
          );

          // Chunk-level retry succeeded
          const retrySummary = retryResult.summary || null;
          console.log(
            `[chunked] Chunk ${i + 1} (${label}): chunk-level retry succeeded, ` +
              `extracted ${retryResult.items.length} item(s)`
          );

          if (enableVerification && retryResult.items.length > 0) {
            try {
              const verificationResult = await provider.verifyExtraction(
                pdfChunks[i],
                retryResult.items,
                onRetry,
                customInstructions
              );

              let verifiedItems = [...retryResult.items];

              if (verificationResult.corrections.length > 0) {
                const { correctedItems, correctionCount } =
                  applyVerificationCorrections(
                    verifiedItems,
                    verificationResult.corrections
                  );
                verifiedItems = correctedItems;
                if (correctionCount > 0) {
                  console.log(
                    `[chunked] Chunk ${i + 1} (retry): ${correctionCount} quantity correction(s)`
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
                    `[chunked] Chunk ${i + 1} (retry): ${renameCount} name correction(s)`
                  );
                }
              }

              if (verificationResult.additions?.length > 0) {
                const newItems = processVerificationAdditions(
                  verificationResult.additions,
                  allItems
                );
                if (newItems.length > 0) {
                  verifiedItems = [...verifiedItems, ...newItems];
                  console.log(
                    `[chunked] Chunk ${i + 1} (retry): ${newItems.length} item(s) added`
                  );
                }
              }

              return { items: verifiedItems, summary: retrySummary, failed: false };
            } catch (verifyError) {
              console.warn(
                `[chunked] Chunk ${i + 1} (retry) verification failed, using unverified:`,
                verifyError instanceof Error
                  ? verifyError.message
                  : verifyError
              );
              return { items: retryResult.items, summary: retrySummary, failed: false };
            }
          } else {
            return { items: retryResult.items, summary: retrySummary, failed: false };
          }
        } catch (retryError) {
          // Chunk-level retry also failed — skip chunk, preserve earlier results
          const retryErrMsg =
            retryError instanceof Error
              ? retryError.message
              : String(retryError);
          console.warn(
            `[chunked] Chunk ${i + 1} (${label}) chunk-level retry also failed ` +
              `(${retryErrMsg.slice(0, 100)}). Skipping chunk.`
          );
          return { items: [], summary: null, failed: true, failedLabel: label };
        }
      }

      // ── Other recoverable errors (413 / PDF processing) ──
      const isRecoverable =
        (provider.name === "anthropic" && isPdfProcessingError(chunkError)) ||
        errObj?.status === 413 ||
        errMsg.includes("413") ||
        errMsg.includes("request_too_large");

      if (isRecoverable) {
        console.warn(
          `[chunked] Chunk ${i + 1} (${label}) failed (${errMsg.slice(0, 100)}). Skipping.`
        );
        return { items: [], summary: null, failed: true, failedLabel: label };
      }
      throw chunkError;
    }
  };

  // ── Execute chunks with bounded concurrency ──
  // Process chunks in waves of CHUNK_CONCURRENCY. Within each wave, chunks run
  // in parallel. Between waves, we wait for all to settle. This gives us:
  //   - Parallel speedup (overlap Anthropic API calls)
  //   - Bounded concurrency (avoid rate limits, CPU contention)
  //   - Consistent error handling (fatal errors propagate via Promise.all)
  if (pdfChunks.length === 1) {
    // Single chunk — just process directly, no parallelism overhead
    const r = await processChunk(0);
    if (r.failed && r.failedLabel) failedChunks.push(r.failedLabel);
    else {
      if (r.summary) summaries.push(r.summary);
      allItems.push(...r.items);
    }
  } else {
    console.log(
      `[chunked] Processing ${pdfChunks.length} chunks with concurrency=${CHUNK_CONCURRENCY}`
    );
    for (let waveStart = 0; waveStart < pdfChunks.length; waveStart += CHUNK_CONCURRENCY) {
      const waveEnd = Math.min(waveStart + CHUNK_CONCURRENCY, pdfChunks.length);
      const indices: number[] = [];
      for (let i = waveStart; i < waveEnd; i++) indices.push(i);

      const waveResults = await Promise.all(indices.map((i) => processChunk(i)));
      for (const r of waveResults) {
        if (r.failed && r.failedLabel) failedChunks.push(r.failedLabel);
        else {
          if (r.summary) summaries.push(r.summary);
          allItems.push(...r.items);
        }
      }
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

  // Pipe segment merge: sum linear items with the same (size, material, system)
  // into one total-length row. Fixes the "12" RCP split into 4 storm-line
  // segments" pattern where each segment's station math is correct but the
  // takeoff needs one total.
  mergedItems = mergePipeSegments(mergedItems);

  if (mergedItems.length !== beforePost) {
    console.log(
      `[chunked] Post-processing: ${beforePost} → ${mergedItems.length} items`
    );
  }

  // ────────────────────────────────────────────────────────────────
  // Targeted verification: re-verify 6-10 high-value items with a focused
  // prompt after post-processing. Only runs for Anthropic provider (OpenAI
  // and Gemini providers don't implement verifyFocused yet). Catches the
  // biggest errors that the broad verification pass missed — primary pipe
  // runs, SSMH depths, rip rap areas, and any low-confidence items.
  //
  // Adds ~$0.50-1.00 per extraction at Opus pricing. Hits the prompt cache
  // from the earlier extract/verify passes if the first chunk's images are
  // still in the 5-minute ephemeral window.
  // ────────────────────────────────────────────────────────────────
  if (
    enableVerification &&
    provider.name === "anthropic" &&
    mergedItems.length > 0 &&
    pdfChunks.length > 0
  ) {
    const anthropicProvider = provider as AnthropicProvider;
    const highValueItems = pickHighValueItemsForVerification(mergedItems);
    if (highValueItems.length > 0) {
      try {
        console.log(
          `[chunked] Targeted verification: re-checking ${highValueItems.length} high-value items...`
        );
        console.log(
          `[chunked]   Items: ${highValueItems
            .map((it) => it.name)
            .slice(0, 10)
            .join(", ")}`
        );
        const focusedResult = await anthropicProvider.verifyFocused(
          pdfChunks[0],
          highValueItems,
          onRetry,
          customInstructions
        );

        if (focusedResult.corrections.length > 0) {
          const { correctedItems, correctionCount } =
            applyVerificationCorrections(mergedItems, focusedResult.corrections);
          mergedItems = correctedItems;
          if (correctionCount > 0) {
            console.log(
              `[chunked] Targeted verification: ${correctionCount} quantity correction(s) applied`
            );
          }
        }

        if (focusedResult.nameCorrections?.length > 0) {
          const { renamedItems, renameCount } = applyNameCorrections(
            mergedItems,
            focusedResult.nameCorrections
          );
          mergedItems = renamedItems;
          if (renameCount > 0) {
            console.log(
              `[chunked] Targeted verification: ${renameCount} name correction(s) applied`
            );
          }
        }

        console.log(
          `[chunked] Targeted verification complete: ${mergedItems.length} items (${focusedResult.corrections.length} corrections, ${focusedResult.nameCorrections?.length ?? 0} renames)`
        );
      } catch (focusedError) {
        console.warn(
          `[chunked] Targeted verification failed, keeping unverified items:`,
          focusedError instanceof Error
            ? focusedError.message
            : focusedError
        );
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Hybrid DPI re-read: if the extraction found storm drain pipes but
  // very few HDPE wye fittings, re-render the storm drain plan view
  // page(s) at 300 DPI and send a focused "read every small callout"
  // prompt. This recovers the small 8-10pt wye/bend/JB labels that
  // native PDF mode's ~72 DPI can't resolve.
  //
  // Cost: ~$0.15-0.30 per page. Only fires when wye count is suspiciously
  // low relative to the number of storm drain pipe items.
  // ────────────────────────────────────────────────────────────────
  if (
    provider.name === "anthropic" &&
    mergedItems.length > 0 &&
    pdfChunks.length > 0
  ) {
    // Count storm drain fittings vs storm drain pipes to detect missing wyes
    const stormPipes = mergedItems.filter(
      (it) =>
        it.measurementType === "linear" &&
        it.system === "storm_drain" &&
        !isManualPlaceholder(it)
    );
    const hdpeWyes = mergedItems.filter(
      (it) =>
        it.measurementType === "count" &&
        /\bWYE\b/i.test(it.name) &&
        it.system === "storm_drain"
    );

    // Heuristic: if we have 3+ storm pipe items but fewer than 3 wye fittings,
    // the extraction likely missed small wye callouts. Trigger the re-read.
    const needsReRead = stormPipes.length >= 3 && hdpeWyes.length < 3;

    if (needsReRead) {
      try {
        // Identify storm drain plan view pages from extracted items' source sheets.
        // These are the pages with the small callout labels we need to re-read.
        const stormSheets = new Set<string>();
        for (const it of mergedItems) {
          if (it.system === "storm_drain" && it.sourceSheetId) {
            stormSheets.add(it.sourceSheetId);
          }
        }

        // Find the most-referenced storm sheet (likely the plan view)
        const sheetCounts = new Map<string, number>();
        for (const it of mergedItems) {
          if (it.system === "storm_drain" && it.sourceSheetId) {
            sheetCounts.set(
              it.sourceSheetId,
              (sheetCounts.get(it.sourceSheetId) ?? 0) + 1
            );
          }
        }

        // Sort by reference count, pick top 1-2 sheets
        const topSheets = [...sheetCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([sheet]) => sheet);

        if (topSheets.length > 0) {
          console.log(
            `[chunked] Hybrid DPI: ${hdpeWyes.length} wyes found but ${stormPipes.length} storm pipes exist. Re-reading pages: ${topSheets.join(", ")} at 300 DPI`
          );

          // We need to figure out which PAGE NUMBERS correspond to these sheet IDs.
          // The AI extracted sourceSheetId but not always the page number.
          // Use the first chunk's PDF and render ALL pages, then pick the ones
          // that match. Actually, simpler: render the first chunk at 300 DPI
          // since storm drain plan views are usually in the first half of the set.
          // Cap at 3 pages to keep cost bounded.
          const { renderPdfToImages } = await import("../pdf-utils");
          const chunkBuffer = Buffer.from(pdfChunks[0], "base64");
          const { getPdfPageCount } = await import("../pdf-utils");
          const totalPages = await getPdfPageCount(chunkBuffer);

          // Render up to 3 pages from the middle of the chunk (where plan views
          // typically are — pages 1-3 are usually title/notes, storm plans are
          // in the middle third).
          const midStart = Math.max(1, Math.floor(totalPages * 0.3));
          const midEnd = Math.min(totalPages, midStart + 2);

          console.log(
            `[chunked] Hybrid DPI: rendering pages ${midStart}-${midEnd} of ${totalPages} at 300 DPI`
          );

          // Suppress font warnings during high-DPI render
          const origWarn = console.warn;
          console.warn = (...args: unknown[]) => {
            const msg = String(args[0] || "");
            if (msg.includes("getPathGenerator") || msg.includes("Helvetica_path")) return;
            origWarn.apply(console, args);
          };

          let hiDpiImages: Buffer[];
          try {
            hiDpiImages = await renderPdfToImages(chunkBuffer, 4.17, {
              start: midStart,
              end: midEnd,
            });
          } finally {
            console.warn = origWarn;
          }

          console.log(
            `[chunked] Hybrid DPI: rendered ${hiDpiImages.length} pages, sending to Opus for wye/fitting re-read`
          );

          const anthropicProvider = provider as AnthropicProvider;
          const pageNums = Array.from(
            { length: midEnd - midStart + 1 },
            (_, i) => midStart + i
          );

          const hiDpiResult = await anthropicProvider.reReadPagesHighDpi(
            hiDpiImages,
            pageNums,
            mergedItems,
            onRetry
          );

          // Apply additions (new fittings found at high DPI)
          if (hiDpiResult.additions && hiDpiResult.additions.length > 0) {
            const newItems = processVerificationAdditions(
              hiDpiResult.additions,
              mergedItems
            );
            if (newItems.length > 0) {
              mergedItems = [...mergedItems, ...newItems];
              console.log(
                `[chunked] Hybrid DPI: found ${newItems.length} NEW fitting(s): ${newItems
                  .map((it) => it.name)
                  .join(", ")}`
              );
            }
          }

          // Apply corrections (quantity fixes on existing items)
          if (hiDpiResult.corrections && hiDpiResult.corrections.length > 0) {
            const { correctedItems, correctionCount } =
              applyVerificationCorrections(
                mergedItems,
                hiDpiResult.corrections
              );
            mergedItems = correctedItems;
            if (correctionCount > 0) {
              console.log(
                `[chunked] Hybrid DPI: ${correctionCount} quantity correction(s)`
              );
            }
          }

          // Apply name corrections
          if (
            hiDpiResult.nameCorrections &&
            hiDpiResult.nameCorrections.length > 0
          ) {
            const { renamedItems, renameCount } = applyNameCorrections(
              mergedItems,
              hiDpiResult.nameCorrections
            );
            mergedItems = renamedItems;
            if (renameCount > 0) {
              console.log(
                `[chunked] Hybrid DPI: ${renameCount} name correction(s)`
              );
            }
          }

          console.log(
            `[chunked] Hybrid DPI complete: ${mergedItems.length} items total`
          );
        }
      } catch (hiDpiError) {
        console.warn(
          "[chunked] Hybrid DPI re-read failed (continuing without it):",
          hiDpiError instanceof Error
            ? hiDpiError.message
            : hiDpiError
        );
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  // FINAL SAFETY-NET MERGE: aggressively combine any linear items with
  // identical name+system that survived all upstream merging. The earlier
  // mergePipeSegments has subtle edge cases (regex doesn't match certain
  // name formats, etc.) that occasionally let duplicates through. This
  // catches anything that slipped through.
  // ────────────────────────────────────────────────────────────────
  mergedItems = finalLinearMergeSafetyNet(mergedItems);

  return {
    summary: combinedSummary + warningNote,
    items: mergedItems,
  };
}

/**
 * Final safety-net merge for linear items. Groups by (lowercase trimmed name
 * | system) — ignores sheet. Sums quantities, merges metadata. This catches
 * AI output where the same pipe is split into many segment-rows (e.g., 9 rows
 * of "6\" DR14 W" from different stations) that the regex-based mergePipeSegments
 * sometimes misses.
 *
 * Only operates on linear items. Placeholders (qty=0 with MEASURE MANUALLY
 * suffix) are passed through unchanged. Count and area items are untouched.
 */
function finalLinearMergeSafetyNet(items: ExtractedItem[]): ExtractedItem[] {
  const groups = new Map<string, ExtractedItem[]>();
  const nonLinear: ExtractedItem[] = [];

  for (const item of items) {
    if (item.measurementType !== "linear" || isManualPlaceholder(item)) {
      nonLinear.push(item);
      continue;
    }
    const key = `${item.name.toLowerCase().trim()}|${(item.system || "").toLowerCase()}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const merged: ExtractedItem[] = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }

    // Multiple rows — sum quantities, keep best metadata
    // Sort by best method then highest confidence to pick the base
    group.sort((a, b) => {
      const mDiff = (METHOD_RANK[b.quantityMethod || ""] ?? 0) - (METHOD_RANK[a.quantityMethod || ""] ?? 0);
      if (mDiff !== 0) return mDiff;
      return (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0);
    });

    const base = { ...group[0] };
    const totalQty = group.reduce((sum, g) => sum + g.quantity, 0);
    base.quantity = totalQty;

    // Append a summary of what was merged to the evidence
    const segmentSummary = group
      .map((g) => `${g.quantity.toFixed(2)} FT`)
      .join(" + ");
    const mergedNote = `[Safety-net merged ${group.length} rows: ${segmentSummary} = ${totalQty.toFixed(2)} FT]`;
    base.evidence = base.evidence
      ? `${mergedNote}. ${base.evidence}`
      : mergedNote;

    base.dedupeKey = buildFallbackKey(base);

    // Merge metadata from siblings
    for (let i = 1; i < group.length; i++) {
      mergeMetadata(base, group[i]);
    }

    console.log(
      `[finalMerge] Safety-net merged ${group.length} rows of "${base.name}" → ${totalQty.toFixed(2)} FT`
    );
    merged.push(base);
  }

  return [...nonLinear, ...merged];
}
