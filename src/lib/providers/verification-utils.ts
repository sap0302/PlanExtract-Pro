import type {
  ExtractedItem,
  QuantityCorrection,
  NameCorrection,
  VerificationAddition,
} from "./types";

/**
 * Apply verification corrections to extracted items.
 * Matches corrections by exact item name.
 */
export function applyVerificationCorrections(
  items: ExtractedItem[],
  corrections: QuantityCorrection[]
): {
  correctedItems: ExtractedItem[];
  correctionCount: number;
} {
  let correctionCount = 0;

  const correctionMap = new Map<string, QuantityCorrection>();
  for (const correction of corrections) {
    correctionMap.set(correction.name, correction);
  }

  const correctedItems = items.map((item) => {
    const correction = correctionMap.get(item.name);
    if (!correction) return item;
    if (correction.correctedQuantity === item.quantity) return item;

    correctionCount++;
    const originalQty =
      item.measurementType === "count"
        ? correction.originalQuantity.toFixed(0)
        : correction.originalQuantity.toFixed(2);
    const correctedQty =
      item.measurementType === "count"
        ? correction.correctedQuantity.toFixed(0)
        : correction.correctedQuantity.toFixed(2);

    const verifyNote = `[Verified: was ${originalQty}, corrected to ${correctedQty} — ${correction.reason}]`;
    const newDescription = item.description
      ? `${item.description} ${verifyNote}`
      : verifyNote;

    return {
      ...item,
      quantity: correction.correctedQuantity,
      description: newDescription,
    };
  });

  return { correctedItems, correctionCount };
}

/**
 * Apply name corrections from verification pass.
 * Matches items by originalName and renames them.
 */
export function applyNameCorrections(
  items: ExtractedItem[],
  nameCorrections: NameCorrection[]
): {
  renamedItems: ExtractedItem[];
  renameCount: number;
} {
  if (!nameCorrections || nameCorrections.length === 0) {
    return { renamedItems: items, renameCount: 0 };
  }

  let renameCount = 0;
  const renameMap = new Map<string, NameCorrection>();
  for (const nc of nameCorrections) {
    renameMap.set(nc.originalName, nc);
  }

  const renamedItems = items.map((item) => {
    const nc = renameMap.get(item.name);
    if (!nc) return item;

    renameCount++;
    const renameNote = `[Renamed: was "${nc.originalName}" — ${nc.reason}]`;
    const newDescription = item.description
      ? `${item.description} ${renameNote}`
      : renameNote;

    return {
      ...item,
      name: nc.correctedName,
      description: newDescription,
    };
  });

  return { renamedItems, renameCount };
}

/**
 * Convert verification additions to ExtractedItems and validate them.
 * When existingItems is provided, filter out additions that match existing items
 * by normalized name + system + measurementType to prevent cross-chunk duplicates.
 */
export function processVerificationAdditions(
  additions: VerificationAddition[],
  existingItems?: ExtractedItem[]
): ExtractedItem[] {
  if (!additions || additions.length === 0) return [];

  // Build a set of existing item keys for duplicate detection
  const existingKeys = new Set<string>();
  if (existingItems) {
    for (const item of existingItems) {
      const key = `${item.name.toLowerCase().trim()}|${item.system}|${item.measurementType}`;
      existingKeys.add(key);
    }
  }

  return additions
    .filter((add) => {
      // Validate required fields
      if (!add.name || typeof add.name !== "string" || !add.name.trim())
        return false;
      if (!add.measurementType || !add.system || !add.unit) return false;
      if (typeof add.quantity !== "number" || isNaN(add.quantity)) return false;

      // Filter out additions that already exist in previously processed items
      if (existingKeys.size > 0) {
        const addKey = `${add.name.toLowerCase().trim()}|${add.system}|${add.measurementType}`;
        if (existingKeys.has(addKey)) return false;
      }

      return true;
    })
    .map((add) => {
      const item: ExtractedItem = {
        name: add.name.trim(),
        description: add.description
          ? `${add.description} [Added in verification: ${add.reason}]`
          : `[Added in verification: ${add.reason}]`,
        measurementType: add.measurementType,
        system: add.system,
        quantity: add.quantity,
        unit: add.unit,
        confidence: add.confidence || "medium",
      };

      // Carry through any audit fields the verification pass provided
      const addAny = add as unknown as Record<string, unknown>;
      if (addAny.sourceSheetId) item.sourceSheetId = addAny.sourceSheetId as string;
      if (addAny.quantityMethod) item.quantityMethod = addAny.quantityMethod as ExtractedItem["quantityMethod"];
      if (addAny.dedupeKey) item.dedupeKey = addAny.dedupeKey as string;
      if (addAny.evidence) item.evidence = addAny.evidence as string;
      if (addAny.nodeRange) item.nodeRange = addAny.nodeRange as string;
      if (addAny.stationRange) item.stationRange = addAny.stationRange as string;
      if (typeof addAny.isDemo === "boolean") item.isDemo = addAny.isDemo;
      if (addAny.folderPath) item.folderPath = addAny.folderPath as string;
      if (Array.isArray(addAny.sourcePages)) item.sourcePages = addAny.sourcePages as number[];
      if (Array.isArray(addAny.assumptions)) item.assumptions = addAny.assumptions as string[];

      return item;
    });
}
