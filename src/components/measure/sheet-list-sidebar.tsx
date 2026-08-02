"use client";

import { useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatMeasurement } from "@/lib/measurement-utils";
import type { MeasurementShape } from "./measurement-canvas";
import { AreaIcon, LinearIcon, CountIcon } from "./measurement-toolbar";

function TypeIcon({ type }: { type: MeasurementShape["type"] }) {
  const wrapperClass = "w-4 h-4 shrink-0 [&>svg]:w-full [&>svg]:h-full";
  if (type === "linear") return <span className={wrapperClass}><LinearIcon /></span>;
  if (type === "count") return <span className={wrapperClass}><CountIcon /></span>;
  return <span className={wrapperClass}><AreaIcon /></span>;
}

/** End-of-row marker — for count items, mirrors the actual marker shape drawn
 * on the canvas (set via the "Properties - [New Count]" dialog) instead of a
 * plain square, so the sidebar matches what you see on the plan. */
function EndMarker({ measurement: m }: { measurement: MeasurementShape }) {
  const color = m.color;

  // Every shape variant renders inside this same fixed-size, centered box so
  // their edges land in one consistent vertical column regardless of shape
  // (the raw shapes have different intrinsic sizes — e.g. the triangle is a
  // 0-width span with border spillover — which threw off alignment before).
  const slot = (content: React.ReactNode) => (
    <span className="w-4 h-4 shrink-0 flex items-center justify-center">{content}</span>
  );

  if (m.type !== "count") {
    return slot(<span className="w-3.5 h-3.5" style={{ backgroundColor: color }} />);
  }
  switch (m.shape) {
    case "square":
      return slot(<span className="w-3.5 h-3.5" style={{ backgroundColor: color }} />);
    case "triangle":
      return slot(
        <span
          className="w-0 h-0"
          style={{
            borderLeft: "7px solid transparent",
            borderRight: "7px solid transparent",
            borderBottom: `12px solid ${color}`,
          }}
        />
      );
    case "cross":
      return slot(
        <span className="relative w-full h-full">
          <span
            className="absolute top-1/2 left-0 w-full h-[5px] -translate-y-1/2"
            style={{ backgroundColor: color }}
          />
          <span
            className="absolute left-1/2 top-0 h-full w-[5px] -translate-x-1/2"
            style={{ backgroundColor: color }}
          />
        </span>
      );
    case "circle":
    default:
      return slot(<span className="w-3.5 h-3.5 rounded-full" style={{ backgroundColor: color }} />);
  }
}

interface SheetListSidebarProps {
  extractionId: string;
  extractionName: string;
  pageCount: number;
  currentPage: number;
  onPageSelect: (page: number) => void;
  measurements: MeasurementShape[];
  selectedId: string | null;
  onMeasurementSelect: (measurement: MeasurementShape) => void;
  /** Dragged a measurement row from its page onto a different page — carries
   * that measurement's type/name/color/shape over so the user can continue
   * placing new ones of the same style on the target page. The dragged item
   * itself is left untouched on its original page. */
  onMeasurementDropOnPage?: (measurement: MeasurementShape, targetPage: number) => void;
  /** A Linear/Area/Count measurement that's mid-draw/placement (started via
   * drag-and-drop) — shown as an extra row with a green "in progress" dot on
   * its target page until the shape is finished, at which point the real
   * completed measurement replaces it (selected, with the usual red dot). */
  pendingPlaceholder?: {
    type: "linear" | "area" | "count";
    page: number;
    label: string;
    color: string;
  } | null;
  /** Every AI-found item, surfaced as its own row on its source page — rows
   * needing manual measurement get the amber "Measure" treatment and start
   * the targetItem/promotion flow on click; already-quantified rows are a
   * plain reference you can click to jump to that page. */
  aiPendingItems?: AiPendingItem[];
  onAiItemSelect?: (item: AiPendingItem) => void;
}

export interface AiPendingItem {
  id: string;
  name: string;
  originalName: string;
  measurementType: "area" | "count" | "linear";
  system: "water" | "storm_drain" | "wastewater" | "other";
  unit: string;
  quantity: number;
  sourceSheetId: string | null;
  evidence: string | null;
  needsMeasurement: boolean;
  page: number;
}

export const MEASUREMENT_DRAG_MIME = "application/x-planextract-measurement";
const DRAG_MIME = MEASUREMENT_DRAG_MIME;

export function SheetListSidebar({
  extractionId,
  extractionName,
  pageCount,
  currentPage,
  onPageSelect,
  measurements,
  selectedId,
  onMeasurementSelect,
  onMeasurementDropOnPage,
  pendingPlaceholder,
  aiPendingItems,
  onAiItemSelect,
}: SheetListSidebarProps) {
  const pages = Array.from({ length: Math.max(pageCount, 0) }, (_, i) => i + 1);
  const baseName = extractionName.replace(/\.pdf$/i, "");
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [dragOverPage, setDragOverPage] = useState<number | null>(null);
  const draggedMeasurementRef = useRef<MeasurementShape | null>(null);

  // Sidebar width is user-resizable via the drag handle on its right edge —
  // measurements (and the canvas behind them) can be cut off by the fixed
  // width otherwise, with no way to see more of either side.
  const MIN_WIDTH = 160;
  const MAX_WIDTH = 600;
  const [width, setWidth] = useState(224); // matches the old fixed w-56 (14rem)
  const resizing = useRef(false);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startWidth = width;

    const onMouseMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (ev.clientX - startX)));
      setWidth(next);
    };
    const onMouseUp = () => {
      resizing.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  };

  const toggleCollapsed = (p: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  return (
    <div className="relative shrink-0 flex" style={{ width }}>
    <div className="flex-1 border-r bg-muted/20 overflow-y-auto overflow-x-hidden">
      {pages.map((p) => {
        // "Scale Reference" lines are auto-created as a visual aid when
        // calibrating scale (see the Scale dialog's "Automatically create
        // dimension line" option) — they're not a real takeoff item, so they
        // stay drawn on the canvas but are left out of this list.
        const pageMeasurements = measurements.filter((m) => m.page === p && m.label !== "Scale Reference");
        const isCollapsed = collapsed.has(p);
        const showPending = pendingPlaceholder && pendingPlaceholder.page === p;
        const pageAiItems = (aiPendingItems ?? []).filter((it) => it.page === p);

        // Count markers sharing the same name collapse into a single row
        // showing their combined quantity (e.g. "5 EA") instead of one row
        // per marker — Linear/Area rows are left alone since their values
        // differ per instance and grouping them wouldn't make sense. Each
        // group keeps the position of its first occurrence in the list.
        type Row = { kind: "single"; m: MeasurementShape } | { kind: "group"; key: string; items: MeasurementShape[] };
        const rows: Row[] = [];
        const groupRowIndex = new Map<string, number>();
        for (const m of pageMeasurements) {
          if (m.type !== "count") {
            rows.push({ kind: "single", m });
            continue;
          }
          const key = m.label || m.type;
          const existingIdx = groupRowIndex.get(key);
          if (existingIdx !== undefined) {
            (rows[existingIdx] as Extract<Row, { kind: "group" }>).items.push(m);
          } else {
            groupRowIndex.set(key, rows.length);
            rows.push({ kind: "group", key, items: [m] });
          }
        }
        return (
          <div
            key={p}
            className={`border-b ${dragOverPage === p ? "ring-2 ring-inset ring-primary bg-primary/10" : ""}`}
            onDragOver={(e) => {
              if (!onMeasurementDropOnPage || !draggedMeasurementRef.current) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setDragOverPage(p);
            }}
            onDragLeave={(e) => {
              // Only clear when actually leaving this page's whole block, not
              // when moving between child elements inside it (dragleave fires
              // for those too, since drag events don't bubble the way normal
              // mouse events do around relatedTarget).
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDragOverPage((cur) => (cur === p ? null : cur));
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOverPage(null);
              const m = draggedMeasurementRef.current;
              draggedMeasurementRef.current = null;
              if (m && onMeasurementDropOnPage) onMeasurementDropOnPage(m, p);
            }}
          >
            <div
              className={`flex items-center gap-1 w-full text-left px-1 py-1.5 text-xs truncate transition-colors
                ${p === currentPage ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-foreground"}
              `}
            >
              <button
                onClick={() => toggleCollapsed(p)}
                className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground"
                title={isCollapsed ? "Expand" : "Collapse"}
              >
                {pageMeasurements.length > 0 || showPending || pageAiItems.length > 0 ? (
                  isCollapsed ? (
                    <ChevronRight className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" />
                  )
                ) : (
                  <span className="inline-block w-3.5 h-3.5" />
                )}
              </button>
              <button
                onClick={() => onPageSelect(p)}
                className="flex items-center gap-2 flex-1 min-w-0 text-left truncate"
                title={`${baseName} — page ${p} (converted to TIF)`}
              >
                {/* Server-rendered PNG preview of the page — the actual .tif is
                    generated on demand since browsers can't display TIFF inline. */}
                <img
                  src={`/api/extractions/${extractionId}/tif/${p}?preview=1`}
                  alt=""
                  loading="lazy"
                  className="w-8 h-10 object-cover border shrink-0 bg-white"
                />
                <span className="truncate">
                  {baseName}_page{p}.tif
                </span>
              </button>
            </div>

            {/* Measurements taken on this page — matches PlanSwift's nested
                "Pages, Bookmarks" tree where each takeoff row sits under its sheet. */}
            {(pageMeasurements.length > 0 || showPending || pageAiItems.length > 0) && !isCollapsed && (
              <div className="pb-1">
                {showPending && pendingPlaceholder && (
                  <div
                    className="flex items-center gap-2 w-full pl-8 pr-2 py-0.5 leading-tight text-sm truncate text-muted-foreground italic"
                    title={`${pendingPlaceholder.label} — still being drawn`}
                  >
                    <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                    <TypeIcon type={pendingPlaceholder.type} />
                    <span className="truncate flex-1">{pendingPlaceholder.label}</span>
                    <span className="shrink-0">Drawing…</span>
                  </div>
                )}
                {pageAiItems.map((item) => (
                  <button
                    key={`${item.id}-${item.page}`}
                    onClick={() => {
                      onPageSelect(p);
                      onAiItemSelect?.(item);
                    }}
                    className={`flex items-center gap-2 w-full text-left pl-8 pr-2 py-0.5 leading-tight text-sm truncate transition-colors ${
                      item.needsMeasurement
                        ? "bg-amber-50 hover:bg-amber-100 text-amber-900"
                        : "hover:bg-muted text-foreground"
                    }`}
                    title={
                      item.needsMeasurement
                        ? `${item.name} — AI-found, needs manual measurement`
                        : `${item.name} — AI-found (${item.quantity} ${item.unit})`
                    }
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${item.needsMeasurement ? "bg-amber-500" : "bg-transparent"}`}
                    />
                    <TypeIcon type={item.measurementType} />
                    <span className="truncate flex-1">{item.name}</span>
                    {item.needsMeasurement ? (
                      <span className="shrink-0 text-amber-700">Measure</span>
                    ) : (
                      <span className="text-muted-foreground shrink-0">
                        {item.quantity} {item.unit}
                      </span>
                    )}
                  </button>
                ))}
                {rows.map((row) => {
                  if (row.kind === "single") {
                    const m = row.m;
                    return (
                      <button
                        key={m.id}
                        onClick={() => {
                          onPageSelect(p);
                          onMeasurementSelect(m);
                        }}
                        draggable={!!onMeasurementDropOnPage}
                        onDragStart={(e) => {
                          draggedMeasurementRef.current = m;
                          e.dataTransfer.effectAllowed = "copy";
                          // Full payload (not just the id) so drop targets outside
                          // this component — e.g. the measure canvas — can read
                          // the dragged item's type/name/color/shape too.
                          e.dataTransfer.setData(
                            DRAG_MIME,
                            JSON.stringify({
                              type: m.type,
                              label: m.label,
                              color: m.color,
                              shape: m.shape,
                            })
                          );
                        }}
                        onDragEnd={() => {
                          draggedMeasurementRef.current = null;
                          setDragOverPage(null);
                        }}
                        className={`flex items-center gap-2 w-full text-left pl-8 pr-2 py-0.5 leading-tight text-sm truncate transition-colors
                          ${m.id === selectedId ? "bg-primary/15 text-primary font-medium" : "hover:bg-muted text-foreground"}
                        `}
                        title={m.label || m.type}
                      >
                        <span
                          className={`w-2 h-2 rounded-full shrink-0 ${m.id === selectedId ? "bg-red-500" : "bg-transparent"}`}
                        />
                        <TypeIcon type={m.type} />
                        <span className="truncate flex-1">{m.label || m.type}</span>
                        <span className="text-muted-foreground shrink-0">
                          {formatMeasurement(m.type, m.valueFt ?? null, m.valueCount ?? null)}
                        </span>
                        <EndMarker measurement={m} />
                      </button>
                    );
                  }

                  // Grouped count row — combined quantity across all markers
                  // sharing this name. Clicking cycles selection through each
                  // instance in the group (so you can still step through
                  // their individual canvas locations one at a time).
                  const items = row.items;
                  const representative = items[0];
                  const total = items.reduce((sum, i) => sum + (i.valueCount ?? 1), 0);
                  const isSelected = items.some((i) => i.id === selectedId);
                  return (
                    <button
                      key={`group-${row.key}`}
                      onClick={() => {
                        onPageSelect(p);
                        const currentIdx = items.findIndex((i) => i.id === selectedId);
                        const next = items[(currentIdx + 1) % items.length];
                        onMeasurementSelect(next);
                      }}
                      draggable={!!onMeasurementDropOnPage}
                      onDragStart={(e) => {
                        draggedMeasurementRef.current = representative;
                        e.dataTransfer.effectAllowed = "copy";
                        e.dataTransfer.setData(
                          DRAG_MIME,
                          JSON.stringify({
                            type: representative.type,
                            label: representative.label,
                            color: representative.color,
                            shape: representative.shape,
                          })
                        );
                      }}
                      onDragEnd={() => {
                        draggedMeasurementRef.current = null;
                        setDragOverPage(null);
                      }}
                      className={`flex items-center gap-2 w-full text-left pl-8 pr-2 py-0.5 leading-tight text-sm truncate transition-colors
                        ${isSelected ? "bg-primary/15 text-primary font-medium" : "hover:bg-muted text-foreground"}
                      `}
                      title={`${row.key} (${items.length} markers)`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${isSelected ? "bg-red-500" : "bg-transparent"}`}
                      />
                      <TypeIcon type={representative.type} />
                      <span className="truncate flex-1">{row.key}</span>
                      <span className="text-muted-foreground shrink-0">
                        {formatMeasurement("count", null, total)}
                      </span>
                      <EndMarker measurement={representative} />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {pages.length === 0 && (
        <div className="p-3 text-xs text-muted-foreground">No pages</div>
      )}
    </div>
      {/* Resize handle — drag to widen/narrow the sidebar so it (and the
          canvas behind it) can't cut off measurements you need to see. */}
      <div
        onMouseDown={startResize}
        className="w-1.5 shrink-0 cursor-col-resize hover:bg-primary/40 active:bg-primary/60"
        title="Drag to resize"
      />
    </div>
  );
}
