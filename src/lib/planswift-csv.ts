/**
 * Parse PlanSwift-style takeoff CSV / text exports and diff them against a
 * PlanExtract extraction. PlanSwift's text/CSV export format looks like this:
 *
 *   Type: Area
 *   Folder: Takeoff
 *   Name,Description,Qty,Units
 *   RIP RAP GROUTED,GROUTED RIP RAP,5811.60,SQ FT
 *   CONCRETE PILOT FLUME,,1593.10,SQ FT
 *   7404.70  <- section subtotal
 *   7404.70  <- running total
 *   Type: Count
 *   ...
 *
 * We support three formats for flexibility:
 *   1. Comma-separated (proper CSV export from PlanSwift)
 *   2. Tab-separated (another PlanSwift export option)
 *   3. Whitespace-separated text dump (copy/paste from PDF preview)
 *
 * Lines starting with "(Image)" are tolerated — PlanSwift prepends these to
 * items with icon thumbnails. Subtotal/total lines (pure numbers) are ignored.
 */

import type { Item } from "@prisma/client";

export type PlanSwiftItemType = "area" | "count" | "linear";

export interface PlanSwiftItem {
  name: string;
  description: string;
  quantity: number;
  unit: string;
  measurementType: PlanSwiftItemType;
  /**
   * System inferred from the trailing suffix in the name (SD / W / WW),
   * or "other" if no suffix is present.
   */
  system: "water" | "storm_drain" | "wastewater" | "other";
}

const TYPE_HEADER_REGEX = /^type\s*:\s*(area|count|linear)\b/i;
const FOLDER_HEADER_REGEX = /^folder\s*:/i;
// Column header line like "Name,Description,Qty,Units" or "Name Description Qty Units"
const COLUMN_HEADER_REGEX = /^(icon\s+)?name\s*[,\t ]+description\s*[,\t ]+qty\s*[,\t ]+units/i;
const PURE_NUMBER_REGEX = /^[\d,]+\.?\d*$/;

/**
 * Normalize an item name for comparison.
 * Mirrors the aggressive normalization in chunked.ts::normalizeItemName so
 * the diff matches identical items with slight naming variations (SD suffix
 * dropped, ROCK RIP RAP collapsed, JUNTION typo, etc.).
 */
export function normalizeForCompare(name: string): string {
  let n = name.toUpperCase().replace(/\s+/g, " ").trim();

  // Strip leading "(IMAGE)" marker from PlanSwift PDF exports
  n = n.replace(/^\(IMAGE\)\s*/, "");

  // Typo fixes
  n = n.replace(/\bJUNTION\b/g, "JUNCTION");
  n = n.replace(/\bRDP\b/g, "RCP");
  n = n.replace(/\bHEDWL\b/g, "HEADWALL");
  n = n.replace(/\bPLGU\b/g, "PLUG");

  // Strip "PROPOSED " prefix
  n = n.replace(/^PROPOSED\s+/g, "");

  // Rip rap canonicalization
  n = n.replace(/\bGROUTED\s+ROCK\s+RIP\s+RAP\b/g, "GROUTED RIP RAP");
  n = n.replace(/\bROCK\s+RIP\s+RAP\b/g, "RIP RAP");
  n = n.replace(/\bRIP\s+RAP\s+GROUTED\b/g, "GROUTED RIP RAP");

  // Concrete pilot canonicalization
  n = n.replace(/\bCONCRETE\s+PILOT\s+CHANNEL\b/g, "CONCRETE PILOT FLUME");
  n = n.replace(/\b4'?\s+CONCRETE\s+PILOT\s+FLUME\b/g, "CONCRETE PILOT FLUME");

  // Collapse duplicate trailing system suffixes
  n = n.replace(/\b(SD|W|WW|DEMO)\s+\1\b/g, "$1");

  // Strip single trailing system suffix
  n = n.replace(/\s+(SD|W|WW|DEMO)$/, "");

  // Final whitespace cleanup
  n = n.replace(/\s+/g, " ").trim();

  return n;
}

/**
 * Split a line into fields. Tries comma-delimited first, then tab, then
 * whitespace (last resort — may break on item names with spaces).
 */
function splitLine(line: string): string[] {
  if (line.includes(",")) {
    // Simple CSV split (doesn't handle quoted commas — PlanSwift exports
    // rarely have them, and when they do the user can quote-escape).
    return line.split(",").map((s) => s.trim());
  }
  if (line.includes("\t")) {
    return line.split("\t").map((s) => s.trim());
  }
  // Whitespace: split on 2+ spaces only so "8" 45 BEND" doesn't get split
  // into pieces. Falls back to single-space for weird inputs.
  const parts = line.split(/\s{2,}/).map((s) => s.trim());
  if (parts.length >= 3) return parts;
  return line.split(/\s+/).map((s) => s.trim());
}

/**
 * Parse a number that may contain commas (e.g. "1,908.69") or have a unit
 * suffix attached ("5811.60 SQ FT"). Returns NaN if unparseable.
 */
function parseQty(raw: string): number {
  const cleaned = raw.replace(/,/g, "").trim();
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)/);
  if (!match) return NaN;
  return parseFloat(match[1]);
}

/**
 * Infer the system (water / storm_drain / wastewater / other) from an item
 * name by looking at the trailing suffix or known keywords.
 */
function inferSystem(rawName: string): PlanSwiftItem["system"] {
  const n = rawName.toUpperCase();
  // Explicit suffix on original name (before normalization)
  if (/\bSD\b/.test(n)) return "storm_drain";
  if (/\bWW\b/.test(n)) return "wastewater";
  if (/\bW\b/.test(n) && !/\bSW\b/.test(n)) return "water";
  // Content-based fallbacks
  if (/\b(SSMH|CLEANOUT|SEWER|SANITARY)\b/.test(n)) return "wastewater";
  if (
    /\b(RCP|HDPE|CURB\s+INLET|HEADWALL|JUNCTION\s+BOX|CATCH\s+BASIN|STORM)\b/.test(
      n
    )
  )
    return "storm_drain";
  if (/\b(HYDRANT|GATE\s+VALVE|WATER\s+MAIN|METER\s+CAN|SADDLE)\b/.test(n))
    return "water";
  return "other";
}

/**
 * Parse a PlanSwift text/CSV export into a flat list of items.
 * Lines are iterated once — sections are tracked via "Type:" header lines.
 */
export function parsePlanSwiftReference(raw: string): {
  items: PlanSwiftItem[];
  errors: string[];
} {
  const items: PlanSwiftItem[] = [];
  const errors: string[] = [];
  let currentType: PlanSwiftItemType | null = null;

  const lines = raw.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo].trim();
    if (!line) continue;

    // Section header
    const typeMatch = line.match(TYPE_HEADER_REGEX);
    if (typeMatch) {
      currentType = typeMatch[1].toLowerCase() as PlanSwiftItemType;
      continue;
    }

    // Skip folder headers, column headers, and pure-number subtotal lines
    if (FOLDER_HEADER_REGEX.test(line)) continue;
    if (COLUMN_HEADER_REGEX.test(line)) continue;
    if (PURE_NUMBER_REGEX.test(line.replace(/,/g, ""))) continue;

    // "Ico" / "n" lines from multi-line column headers in PDF text dumps
    if (/^(ico|n)$/i.test(line)) continue;

    if (!currentType) {
      // We haven't seen a Type: header yet — skip project-title noise
      continue;
    }

    const parts = splitLine(line);
    if (parts.length < 2) continue;

    // Expected column order: Name, Description, Qty, Units
    // But the CSV format varies. We scan from the right for a number that
    // could be the quantity, and then a unit, and treat everything before
    // the quantity column as name + description.
    let qtyIdx = -1;
    for (let i = parts.length - 1; i >= 0; i--) {
      const maybeQty = parseQty(parts[i]);
      if (!isNaN(maybeQty) && maybeQty > 0) {
        qtyIdx = i;
        break;
      }
    }

    if (qtyIdx === -1) {
      continue; // No quantity found — probably a header or malformed row
    }

    const qty = parseQty(parts[qtyIdx]);
    // Unit is whatever comes after the quantity, if anything
    const unit =
      qtyIdx + 1 < parts.length
        ? parts.slice(qtyIdx + 1).join(" ").trim()
        : guessUnit(currentType);

    // Name + description come before the quantity.
    // If there are 2+ fields, first = name, rest = description.
    // If only 1 field, that's the name and description is empty.
    const nameDescFields = parts.slice(0, qtyIdx);
    let name = "";
    let description = "";
    if (nameDescFields.length === 0) {
      continue; // No name, skip
    } else if (nameDescFields.length === 1) {
      name = nameDescFields[0];
    } else {
      name = nameDescFields[0];
      description = nameDescFields.slice(1).join(" ").trim();
    }

    // Strip leading "(Image)" marker
    name = name.replace(/^\(IMAGE\)\s*/i, "").trim();
    if (!name) continue;

    items.push({
      name,
      description,
      quantity: qty,
      unit,
      measurementType: currentType,
      system: inferSystem(name),
    });
  }

  return { items, errors };
}

function guessUnit(type: PlanSwiftItemType): string {
  if (type === "area") return "SQ FT";
  if (type === "linear") return "FT";
  return "EA";
}

// ────────────────────────────────────────────────────────────────
// Diff logic
// ────────────────────────────────────────────────────────────────

export interface DiffRow {
  /** How the item was matched (or why it wasn't) */
  status: "exact" | "close" | "missing" | "extra" | "quantity-mismatch";
  /** Reference item (from PlanSwift CSV), if present */
  reference: PlanSwiftItem | null;
  /** Extraction item (from DB), if present */
  extraction: Item | null;
  /** Percentage difference if both exist and have numeric quantities */
  pctDelta: number | null;
}

export interface DiffSummary {
  exact: number;
  close: number;
  quantityMismatch: number;
  missing: number;
  extra: number;
  totalReference: number;
  totalExtraction: number;
  /**
   * Match rate = exact matches / total reference items (as a ratio 0–1)
   */
  matchRate: number;
}

export interface DiffResult {
  rows: DiffRow[];
  summary: DiffSummary;
}

/**
 * Compare a list of PlanSwift reference items against a list of extraction
 * items. Match criteria (applied in order):
 *   1. Exact match: normalized name AND measurementType match, quantity within 5%
 *   2. Close match: normalized name + measurementType match, quantity within 25%
 *   3. Quantity mismatch: normalized name + measurementType match but quantity off by >25%
 *   4. Missing: reference item with no extraction match
 *   5. Extra: extraction item with no reference match
 */
export function diffExtractionAgainstReference(
  reference: PlanSwiftItem[],
  extraction: Item[]
): DiffResult {
  // Bucket both sides by (normalized name + measurementType) for O(1) lookup
  const extByKey = new Map<string, Item[]>();
  for (const it of extraction) {
    const key = `${normalizeForCompare(it.name)}|${it.measurementType}`;
    const bucket = extByKey.get(key);
    if (bucket) bucket.push(it);
    else extByKey.set(key, [it]);
  }

  const rows: DiffRow[] = [];
  const matchedExtractionIds = new Set<string>();

  // Pass 1: for each reference item, find a matching extraction item
  for (const ref of reference) {
    const key = `${normalizeForCompare(ref.name)}|${ref.measurementType}`;
    const candidates = extByKey.get(key) ?? [];

    if (candidates.length === 0) {
      rows.push({
        status: "missing",
        reference: ref,
        extraction: null,
        pctDelta: null,
      });
      continue;
    }

    // Pick the first unmatched candidate (usually only one per key)
    const match = candidates.find((c) => !matchedExtractionIds.has(c.id));
    if (!match) {
      rows.push({
        status: "missing",
        reference: ref,
        extraction: null,
        pctDelta: null,
      });
      continue;
    }
    matchedExtractionIds.add(match.id);

    // Compute quantity delta percentage
    const refQty = ref.quantity;
    const extQty = match.quantity;
    let pctDelta: number | null = null;
    if (refQty > 0) {
      pctDelta = ((extQty - refQty) / refQty) * 100;
    }

    let status: DiffRow["status"];
    if (pctDelta === null || Math.abs(pctDelta) <= 5) {
      status = "exact";
    } else if (Math.abs(pctDelta) <= 25) {
      status = "close";
    } else {
      status = "quantity-mismatch";
    }

    rows.push({
      status,
      reference: ref,
      extraction: match,
      pctDelta,
    });
  }

  // Pass 2: extraction items that weren't matched to any reference = extras
  for (const it of extraction) {
    if (!matchedExtractionIds.has(it.id)) {
      rows.push({
        status: "extra",
        reference: null,
        extraction: it,
        pctDelta: null,
      });
    }
  }

  const summary: DiffSummary = {
    exact: rows.filter((r) => r.status === "exact").length,
    close: rows.filter((r) => r.status === "close").length,
    quantityMismatch: rows.filter((r) => r.status === "quantity-mismatch")
      .length,
    missing: rows.filter((r) => r.status === "missing").length,
    extra: rows.filter((r) => r.status === "extra").length,
    totalReference: reference.length,
    totalExtraction: extraction.length,
    matchRate:
      reference.length > 0
        ? rows.filter((r) => r.status === "exact").length / reference.length
        : 0,
  };

  return { rows, summary };
}
