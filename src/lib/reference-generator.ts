/**
 * Generates PlanSwift-style reference text from a finalized extraction's items.
 * The output matches the format that buildUserPromptWithExamples() expects,
 * so it can be saved as a ReferenceExample and injected into future prompts.
 */

import type { Item, Measurement } from "@prisma/client";

const MANUAL_MEASURE_SUFFIX = " - MEASURE MANUALLY";
const TRACED_MARKER = " [VERIFIED BY MANUAL TRACE]";

/**
 * Format extraction items into PlanSwift-style reference text.
 * Groups by measurement type (Area/Count/Linear), sorted by name.
 * Skips placeholder items (qty=0 with MEASURE MANUALLY suffix).
 *
 * If `measurements` are provided, items whose `id` matches a measurement's
 * `itemId` get a "[VERIFIED BY MANUAL TRACE]" annotation appended to the
 * item name in the output. This signals to the AI on future extractions
 * that the estimator hand-verified this size/material combo, so it should
 * NOT default to a Tier 3 placeholder for similar pipes on similar projects.
 *
 * The `measurements` parameter is optional and defaults to an empty array
 * for backward compatibility with all existing callers and stored references.
 */
export function generateReferenceText(
  items: Item[],
  projectName?: string,
  measurements: Measurement[] = []
): string {
  // Filter out placeholders and zero-quantity items
  const validItems = items.filter(
    (item) =>
      item.quantity > 0 &&
      !item.name.endsWith(MANUAL_MEASURE_SUFFIX) &&
      !item.isDemo
  );

  if (validItems.length === 0) {
    return "";
  }

  // Set of item IDs that have at least one linked traced measurement.
  // Used below to annotate the item name in the output.
  const tracedItemIds = new Set<string>();
  for (const m of measurements) {
    if (m.itemId) tracedItemIds.add(m.itemId);
  }

  const formatName = (item: Item): string =>
    tracedItemIds.has(item.id) ? `${item.name}${TRACED_MARKER}` : item.name;

  // Group by measurement type
  const groups: Record<string, Item[]> = {
    area: [],
    count: [],
    linear: [],
  };

  for (const item of validItems) {
    const key = item.measurementType.toLowerCase();
    if (groups[key]) {
      groups[key].push(item);
    }
  }

  // Sort each group by name
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.name.localeCompare(b.name));
  }

  const lines: string[] = [];

  if (projectName) {
    lines.push(`Project: ${projectName}`);
    lines.push("");
  }

  // Area items
  if (groups.area.length > 0) {
    lines.push("Type: Area");
    for (const item of groups.area) {
      lines.push(`  ${formatName(item)}   ${item.quantity.toFixed(2)} ${item.unit}`);
    }
    lines.push("");
  }

  // Count items
  if (groups.count.length > 0) {
    lines.push("Type: Count");
    for (const item of groups.count) {
      lines.push(`  ${formatName(item)}   ${item.quantity.toFixed(0)} ${item.unit}`);
    }
    lines.push("");
  }

  // Linear items
  if (groups.linear.length > 0) {
    lines.push("Type: Linear");
    for (const item of groups.linear) {
      lines.push(`  ${formatName(item)}   ${item.quantity.toFixed(2)} ${item.unit}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Infer project type from the dominant system in the extraction items.
 */
export function inferProjectType(items: Item[]): string {
  const systemCounts: Record<string, number> = {};
  for (const item of items) {
    const sys = item.system || "other";
    systemCounts[sys] = (systemCounts[sys] || 0) + 1;
  }

  const systems = Object.keys(systemCounts);
  if (systems.length === 0) return "mixed";
  if (systems.length === 1) return systems[0];

  // If multiple systems, return "mixed"
  return "mixed";
}
