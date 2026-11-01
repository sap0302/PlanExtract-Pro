import type { ToolMode } from "../components/measurement-toolbar";

export const MANUAL_MEASURE_SUFFIX = " - MEASURE MANUALLY";

export const TOOL_INSTRUCTIONS: Record<ToolMode, string> = {
  select: "Click a line or marker to select it. Drag or right-drag to pan. Scroll to zoom. Delete removes the selection.",
  calibrate: "Click two endpoints of a known dimension on the plan.",
  linear: "Click along the run. Right-click, double-click, or Enter to finish. Backspace undoes the last point. Esc cancels.",
  area: "Click polygon vertices. Right-click or click the start point to close. Backspace undoes the last point. Esc cancels.",
  count: "Click to place a marker. Click an item in the list to keep counting it.",
};

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;
/** Multiplier for one zoom step from the ribbon buttons or +/- keys. */
export const ZOOM_STEP = 1.25;

/** Zoom multiplier for one wheel event. A mouse notch (deltaY ~100) gives ~1.28x; trackpad ticks are smaller. */
export function wheelZoomFactor(deltaY: number): number {
  const factor = Math.exp(-deltaY * 0.0025);
  return Math.min(1.5, Math.max(1 / 1.5, factor));
}

/** Distinct takeoff colors, cycled so each new item gets its own color by default. */
export const ITEM_COLOR_PALETTE = [
  "#FF0000",
  "#0066FF",
  "#00A651",
  "#FF8C00",
  "#800080",
  "#00B7C3",
  "#E6007E",
  "#8B4513",
  "#4B6EAF",
  "#B5B500",
  "#FF66B2",
  "#2E8B57",
];

/** First palette color not yet used by an existing measurement; cycles when all are taken. */
export function nextUnusedColor(usedColors: Iterable<string>): string {
  const used = new Set(Array.from(usedColors, (c) => c.toLowerCase()));
  const free = ITEM_COLOR_PALETTE.find((c) => !used.has(c.toLowerCase()));
  if (free) return free;
  return ITEM_COLOR_PALETTE[used.size % ITEM_COLOR_PALETTE.length];
}
