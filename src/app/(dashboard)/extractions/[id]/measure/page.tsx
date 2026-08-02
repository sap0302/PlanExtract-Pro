"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { PdfViewer } from "@/components/measure/pdf-viewer";
import {
  MeasurementToolbar,
  type ToolMode,
} from "@/components/measure/measurement-toolbar";
import {
  MeasurementCanvas,
  type MeasurementShape,
  type MeasurementCanvasHandle,
} from "@/components/measure/measurement-canvas";
import type { AddToItemsData } from "@/components/measure/measurement-panel";
import { MeasurementFloatingActions } from "@/components/measure/measurement-floating-actions";
import { SheetListSidebar, MEASUREMENT_DRAG_MIME } from "@/components/measure/sheet-list-sidebar";
import { ScaleDialog } from "@/components/measure/scale-dialog";
import { PropertiesDialog, type MeasurementStyle } from "@/components/measure/properties-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { Point } from "@/lib/measurement-utils";
import { decodeSnippetsFromUrl } from "@/lib/evidence-snippets";

interface ExtractionData {
  id: string;
  name: string;
  /** "manual" for Manual Mode extractions (created with no AI involvement at
   * all) — used to hide every AI-related affordance on this page for them. */
  provider?: string;
  scalePixelsPerFoot: number | null;
  scaleCalibrationJson: string | null;
  /** JSON: { [page]: pixelsPerFoot } — set by calibrating a page without "Apply Scale to all pages". Overrides scalePixelsPerFoot for that page. */
  scalePerPageJson: string | null;
  pageCount: number | null;
  /** Already included in GET /api/extractions/:id's response (it `include`s
   * items) — declared here so the AI-found "MEASURE MANUALLY" placeholders
   * can be surfaced directly in the sidebar without a per-item fetch. */
  items?: Array<{
    id: string;
    name: string;
    measurementType: string;
    system: string;
    unit: string;
    quantity: number;
    sourceSheetId: string | null;
    evidence: string | null;
    sourcePages: string | null;
  }>;
}

/**
 * Target item when measure page is opened with ?item=<id> — we show a banner,
 * and "Add to items" promotes this placeholder instead of creating a new item.
 */
interface TargetItem {
  id: string;
  name: string;                         // name WITHOUT the " - MEASURE MANUALLY" suffix
  originalName: string;                 // name WITH the suffix (for display)
  measurementType: "area" | "count" | "linear";
  system: "water" | "storm_drain" | "wastewater" | "other";
  unit: string;
  sourceSheetId: string | null;
  evidence: string | null;
}

const MANUAL_MEASURE_SUFFIX = " - MEASURE MANUALLY";

// Contextual instructions per tool
const toolInstructions: Record<ToolMode, string> = {
  select: "Click a measurement to select it. Hold Space to pan. Scroll to zoom.",
  calibrate: "Click two endpoints of a known dimension on the plan.",
  linear: "Click along the pipe run. Double-click or Enter to finish. Ctrl+Z to undo last point. Esc to cancel.",
  area: "Click polygon vertices. Click near start point to close. Ctrl+Z to undo last point. Esc to cancel.",
  count: "Click to place a marker. Each click creates one count.",
};

export default function MeasurePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const targetItemId = searchParams.get("item");
  // "View on PDF" feature — inventory rows pass `?page=N&snippets=...` to jump
  // straight to the right page with the AI's evidence text highlighted.
  const initialPage = (() => {
    const raw = searchParams.get("page");
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 1;
  })();
  const initialSnippets = decodeSnippetsFromUrl(searchParams.get("snippets"));
  const canvasRef = useRef<MeasurementCanvasHandle>(null);
  // Actual visible viewport size (from PdfViewer's renderOverlay render-prop) —
  // NOT the same as pdfDimensions (the PDF page's raw pixel size at zoom=1).
  // Pan/zoom centering must use this, since panOffset is applied relative to
  // the container's top-left, not the PDF page's.
  const viewportDimsRef = useRef({ width: 800, height: 600 });

  const [extraction, setExtraction] = useState<ExtractionData | null>(null);
  const [measurements, setMeasurements] = useState<MeasurementShape[]>([]);

  // Every AI-found item, surfaced directly in the sidebar on EVERY one of its
  // source pages (an item found on multiple pages — same name/properties,
  // e.g. a pipe run's callout repeated on both plan and profile sheets —
  // gets one row per page, not just its first sourcePages entry) — not just
  // the Tier 3 "MEASURE MANUALLY" placeholders. Items still needing manual
  // measurement (quantity still 0) get the amber "Measure" treatment and the
  // full targetItem/promotion flow; items the AI already quantified show as
  // a plain reference row you can click to jump straight to that page,
  // without requiring the user to go back to the extraction's Items list
  // first for either case.
  const aiItems = useMemo(() => {
    if (!extraction?.items) return [];
    return extraction.items.flatMap((it) => {
      const needsMeasurement = it.name.endsWith(MANUAL_MEASURE_SUFFIX) && it.quantity === 0;
      // Items created via "Add to Items" (manual mode, or promoting a
      // placeholder) never get a sourcePages value — that field only ever
      // comes from AI extraction. Such an item's actual measurement(s)
      // already show up as their own row(s) in the sidebar's normal
      // measurement list, so surfacing it AGAIN here (even on the correct
      // page) would just be a duplicate of that row with no extra
      // information — this list exists to reference AI-found items that
      // aren't otherwise visible on the canvas/sidebar, not to shadow every
      // real measurement. So items without sourcePages are skipped entirely.
      if (!it.sourcePages) return [];
      // An item that already has a real measurement linked to it (drawn and
      // "Add to Items"-ed, whether newly created or an AI placeholder that
      // got promoted) is already shown via that measurement's own row — so
      // even though it legitimately HAS AI sourcePages, surfacing it again
      // here would duplicate that row rather than reference something
      // otherwise invisible.
      if (measurements.some((m) => m.itemId === it.id)) return [];
      let pages: number[] = [];
      try {
        const parsed = JSON.parse(it.sourcePages) as number[];
        if (Array.isArray(parsed) && parsed.length > 0) pages = parsed;
      } catch {
        return [];
      }
      if (pages.length === 0) return [];

      // For count-type items, sourcePages lists one entry PER counted marker
      // (not once per distinct page) — e.g. 3 hydrants on page 4 shows up as
      // [4, 4, 4]. So the real per-page quantity is how many times that page
      // number occurs in the array, not the item's overall total (which is
      // what a naive "1 row per distinct page, showing the full quantity"
      // would have shown on every one of those pages). Linear/Area items
      // aren't discrete occurrences the same way, so those keep the item's
      // actual measured value on each page it was found on.
      const pageOccurrences = new Map<number, number>();
      for (const p of pages) pageOccurrences.set(p, (pageOccurrences.get(p) || 0) + 1);

      return Array.from(pageOccurrences.keys()).map((page) => ({
        id: it.id,
        name: needsMeasurement ? it.name.slice(0, -MANUAL_MEASURE_SUFFIX.length) : it.name,
        originalName: it.name,
        measurementType: it.measurementType as "area" | "count" | "linear",
        system: it.system as "water" | "storm_drain" | "wastewater" | "other",
        unit: it.unit,
        quantity: it.measurementType === "count" ? pageOccurrences.get(page)! : it.quantity,
        sourceSheetId: it.sourceSheetId,
        evidence: it.evidence,
        needsMeasurement,
        page,
      }));
    });
  }, [extraction?.items, measurements]);

  // Per-page scale (see scalePerPageJson on the schema) overrides the global
  // scalePixelsPerFoot for whichever page it was set on — used whenever a
  // calibration was done WITHOUT "Apply Scale to all pages" checked, so each
  // page can carry its own scale independent of the others.
  const ppfForPage = useCallback(
    (page: number): number | null => {
      if (!extraction) return null;
      if (extraction.scalePerPageJson) {
        try {
          const perPage = JSON.parse(extraction.scalePerPageJson) as Record<string, number>;
          const override = perPage[String(page)];
          if (override != null) return override;
        } catch {
          // fall through to global
        }
      }
      return extraction.scalePixelsPerFoot;
    },
    [extraction]
  );
  const isPageCalibrated = useCallback(
    (page: number): boolean => {
      const p = ppfForPage(page);
      return p != null && p > 0;
    },
    [ppfForPage]
  );

  const [targetItem, setTargetItem] = useState<TargetItem | null>(null);
  const [loading, setLoading] = useState(true);

  // Viewer state
  const [currentPage, setCurrentPage] = useState(initialPage);
  // Text-search highlights pulled from the URL (?snippets=...) — passed to
  // PdfViewer which finds them on the current page via getTextContent and
  // draws yellow boxes. Setting to [] hides all highlights.
  const [textHighlights, setTextHighlights] = useState<string[]>(initialSnippets);
  // Every AI-found item on the current page, reflected as free text-layer
  // highlights (same mechanism as "View on PDF" — no AI vision call, just
  // matches each item's evidence/callout text against the rendered page).
  // Recomputed automatically whenever the page changes, unlike textHighlights
  // above which is user-controlled and gets cleared once you start drawing.
  //
  // The matcher (PdfViewer) requires a single PDF text-layer item to literally
  // *contain* the query as a substring — full evidence sentences like "Note
  // at bottom of Sheet 15 states: 'INSTALL CLEANOUT...'" are AI paraphrases,
  // not verbatim plan text, so they almost never match anything. What DOES
  // reliably match: the item's own name (usually a short callout string
  // lifted straight from the plan, e.g. `24" CULVERT`) and any quoted
  // substrings inside evidence (the AI quotes exact plan text there).
  const currentPageAiItemHighlights = useMemo(() => {
    const extractQuoted = (text: string | null): string[] => {
      if (!text) return [];
      const matches = text.match(/['"“”‘’]([^'"“”‘’]{3,60})['"“”‘’]/g) || [];
      return matches.map((m) => m.slice(1, -1).trim()).filter((s) => s.length >= 3);
    };
    const tokens = aiItems
      .filter((it) => it.page === currentPage)
      .flatMap((it) => [it.name, ...extractQuoted(it.evidence)]);
    return Array.from(new Set(tokens.filter((s): s is string => !!s && s.trim().length >= 3)));
  }, [aiItems, currentPage]);
  // Memoized so PdfViewer's text-search effect (keyed on this array by
  // reference) doesn't re-run its pdf.js text-layer scan on every render.
  const combinedTextHighlights = useMemo(
    () => [...textHighlights, ...currentPageAiItemHighlights],
    [textHighlights, currentPageAiItemHighlights]
  );
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  // Refs mirroring zoom/panOffset for use inside zoomTo (see below) and the
  // keyboard-shortcut effect, so those don't need zoom/panOffset in their
  // dependency arrays.
  const zoomRef = useRef(zoom);
  const panOffsetRef = useRef(panOffset);
  // Last known cursor position over the canvas, in container-space pixels
  // (same space as viewportDimsRef) — reported by MeasurementCanvas's
  // onCursorMove, null once the cursor leaves the canvas. Lets Zoom In/Out
  // (and +/-) magnify around the cursor like the mouse wheel already does,
  // falling back to the viewport center when there's no cursor to anchor on.
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);
  // Base PDF page size at zoom=1 (mirrors the `pdfDimensions` state set by
  // handleCanvasReady below) — kept in a ref too so zoomTo/fitPage can clamp
  // without depending on the pdfDimensions state (declared further down).
  const pdfDimensionsRef = useRef({ width: 0, height: 0 });
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    panOffsetRef.current = panOffset;
  }, [panOffset]);

  // Mirrors PdfViewer's own pan clamp (which prevents dragging the page past
  // its edge) — applied here too so zoomTo/fitPage never produce a pan value
  // PdfViewer will immediately correct on its next render. Without this, a
  // zoom step that lands out-of-bounds would visually apply instantly, then
  // snap back ~150ms later when PdfViewer's debounced re-render re-clamps it
  // — that second, delayed correction is what reads as a "shake".
  const clampPanOffset = useCallback((offset: { x: number; y: number }, atZoom: number) => {
    const cw = viewportDimsRef.current.width;
    const ch = viewportDimsRef.current.height;
    const contentW = pdfDimensionsRef.current.width * atZoom;
    const contentH = pdfDimensionsRef.current.height * atZoom;
    if (cw === 0 || ch === 0 || contentW === 0 || contentH === 0) return offset;
    const clampAxis = (value: number, containerSize: number, contentSize: number) => {
      const lo = Math.min(0, containerSize - contentSize);
      const hi = Math.max(0, containerSize - contentSize);
      return Math.min(hi, Math.max(lo, value));
    };
    return {
      x: clampAxis(offset.x, cw, contentW),
      y: clampAxis(offset.y, ch, contentH),
    };
  }, []);

  // Floor on zoom: never let the page's rendered height shrink smaller than
  // the visible viewport height (i.e. you can't zoom out past "page height
  // fills the viewport" — no gray space above/below the page).
  const getMinZoom = useCallback(() => {
    const ch = viewportDimsRef.current.height;
    const pageH = pdfDimensionsRef.current.height;
    if (!pageH) return 0.1;
    return Math.max(0.1, ch / pageH);
  }, []);

  // Zoom in/out (ribbon buttons, keyboard +/-) previously just set zoom
  // without touching panOffset — since the canvas scales from its top-left
  // corner, that made the page visibly jump toward the bottom-right on every
  // click. This mirrors the mouse wheel's cursor-centered zoom: it anchors on
  // the last known cursor position over the canvas (reported via
  // MeasurementCanvas's onCursorMove), falling back to the viewport center
  // when the cursor isn't over the canvas (e.g. Fit Page, or the cursor is
  // over the ribbon itself).
  const zoomTo = useCallback((requestedZoom: number) => {
    const newZoom = Math.max(getMinZoom(), requestedZoom);
    const cw = viewportDimsRef.current.width;
    const ch = viewportDimsRef.current.height;
    const anchor = cursorPosRef.current ?? { x: cw / 2, y: ch / 2 };
    const z = zoomRef.current;
    const po = panOffsetRef.current;
    const localCx = (anchor.x - po.x) / z;
    const localCy = (anchor.y - po.y) / z;
    setZoom(newZoom);
    setPanOffset(
      clampPanOffset(
        {
          x: anchor.x - localCx * newZoom,
          y: anchor.y - localCy * newZoom,
        },
        newZoom
      )
    );
  }, [clampPanOffset, getMinZoom]);
  // Fit Page always re-centers on the viewport, ignoring the cursor.
  const fitPage = useCallback(() => {
    const newZoom = Math.max(getMinZoom(), 1);
    const cw = viewportDimsRef.current.width;
    const ch = viewportDimsRef.current.height;
    const z = zoomRef.current;
    const po = panOffsetRef.current;
    const localCx = (cw / 2 - po.x) / z;
    const localCy = (ch / 2 - po.y) / z;
    setZoom(newZoom);
    setPanOffset(
      clampPanOffset({ x: cw / 2 - localCx * newZoom, y: ch / 2 - localCy * newZoom }, newZoom)
    );
  }, [clampPanOffset, getMinZoom]);
  const [activeTool, setActiveTool] = useState<ToolMode>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSpaceDown, setIsSpaceDown] = useState(false);

  // activeTool doesn't otherwise reset on page navigation — without this, a
  // scale-requiring tool selected on a calibrated page would stay active
  // (and drawable, until handleMeasurementComplete's own guard rejects it)
  // after navigating to an uncalibrated page. Bail out here first so the
  // user sees the warning immediately, before even attempting to draw.
  useEffect(() => {
    if (
      (activeTool === "linear" || activeTool === "area" || activeTool === "count") &&
      !isPageCalibrated(currentPage)
    ) {
      setActiveTool("select");
      toast.warning(`Set the plan scale for page ${currentPage} first before measuring.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage]);

  // Dragging a Linear/Area/Count item onto a page (sidebar or canvas) can't
  // finish the measurement immediately — even Count still needs a click on
  // the target page's canvas to actually place a marker there. This
  // placeholder shows a "still being drawn/placed" row (green dot) on the
  // target page in the sidebar right away, so the drag has visible feedback
  // instead of silently just switching tools. It's cleared — and the real
  // completed measurement gets selected (red dot) instead — once the shape
  // is finished/placed, or cleared outright if cancelled (Escape / tool
  // switch away).
  const [pendingPlaceholder, setPendingPlaceholder] = useState<{
    type: "linear" | "area" | "count";
    page: number;
    label: string;
    color: string;
  } | null>(null);

  // PDF dimensions (reported by PdfViewer on render)
  const [pdfDimensions, setPdfDimensions] = useState({ width: 0, height: 0 });
  // True page count reported by PdfViewer once it loads the PDF client-side —
  // authoritative over extraction.pageCount, which can be null/stale in the DB.
  const [livePageCount, setLivePageCount] = useState(0);

  // Undo stack: stores measurement IDs in creation order
  const undoStack = useRef<string[]>([]);

  // Calibration dialog (fallback distance entry — used when the user starts
  // calibration via keyboard shortcut "R" without going through Scale dialog first)
  const [showCalibrationDialog, setShowCalibrationDialog] = useState(false);
  const [calibrationPoints, setCalibrationPoints] = useState<[Point, Point] | null>(null);
  const [calibrationDistance, setCalibrationDistance] = useState("");

  // Scale setup dialog (PlanSwift-style "Scale" popup opened from the ribbon)
  const [showScaleDialog, setShowScaleDialog] = useState(false);
  // Distance + options entered in the Standard tab, applied once the user
  // clicks the two endpoints on the plan.
  const [pendingScaleSettings, setPendingScaleSettings] = useState<{
    distanceFt: number;
    applyToAllPages: boolean;
    autoCreateDimensionLine: boolean;
  } | null>(null);

  // Linear tool style (name/color) — set via the "Properties - [Linear]"
  // dialog opened from the ribbon, applied to subsequently drawn linear
  // measurements.
  const [showLinearProperties, setShowLinearProperties] = useState(false);
  const [linearStyle, setLinearStyle] = useState<MeasurementStyle>({
    name: "Linear",
    color: "#FF0000",
  });

  // Count tool style (name/shape/color/scaled) — set via the "Properties -
  // [New Count]" dialog opened from the ribbon.
  const [showCountProperties, setShowCountProperties] = useState(false);
  const [countStyle, setCountStyle] = useState<MeasurementStyle>({
    name: "New Count",
    color: "#800080",
    shape: "circle",
    scaled: false,
  });

  // Area tool style (name/color) — set via the "Properties - [Area]" dialog
  // opened from the ribbon, applied to subsequently drawn area measurements
  // (and carried over when dragging an area item onto another page — see
  // handleMeasurementDropOnPage).
  const [showAreaProperties, setShowAreaProperties] = useState(false);
  const [areaStyle, setAreaStyle] = useState<MeasurementStyle>({
    name: "Area",
    color: "#4CAF6E",
  });

  // Remembers which tool's Properties dialog to open once scale actually
  // gets set — filled in by the toolbar's requireScale() guard when the
  // user clicks Area/Linear/Count before scale is ready, so they don't have
  // to notice scale is now set and click the button again themselves.
  const pendingToolAfterScaleRef = useRef<"area" | "linear" | "count" | null>(null);
  const openPropertiesFor = useCallback((tool: "area" | "linear" | "count") => {
    setActiveTool(tool);
    if (tool === "area") setShowAreaProperties(true);
    else if (tool === "linear") setShowLinearProperties(true);
    else setShowCountProperties(true);
  }, []);
  const resumePendingToolIfAny = useCallback(() => {
    const tool = pendingToolAfterScaleRef.current;
    if (!tool) return;
    pendingToolAfterScaleRef.current = null;
    openPropertiesFor(tool);
  }, [openPropertiesFor]);

  // AI-assisted measurement state
  const [autoScaleLoading, setAutoScaleLoading] = useState(false);
  const [autoScaleResult, setAutoScaleResult] = useState<{
    notation: string;
    barStart: Point;
    barEnd: Point;
    barLengthFeet: number;
    page: number;
    pixelsPerFoot: number;
    confidence: number;
  } | null>(null);

  // Page count — prefer the live count reported by PdfViewer once loaded.
  const pageCount = livePageCount || extraction?.pageCount || 0;

  const handlePageCountReady = useCallback((count: number) => {
    setLivePageCount(count);
  }, []);

  // Re-fetches measurements from the server and replaces local state. Used
  // after calibrating scale — the calibrate endpoint retroactively
  // recomputes valueFt for any measurement that was drawn before a scale
  // existed for its page (previously stuck at 0.00 FT), and that recompute
  // only happens server-side, so the client needs to pull the fresh values.
  const refreshMeasurements = useCallback(async () => {
    try {
      const res = await fetch(`/api/extractions/${id}/measurements`);
      if (!res.ok) return;
      const { measurements: meas } = await res.json();
      const parsed = meas.map((m: Record<string, unknown>) => ({
        id: m.id as string,
        type: m.type as string,
        points: JSON.parse(m.pointsJson as string) as Point[],
        page: m.page as number,
        color: m.color as string,
        label: m.label as string | undefined,
        valueFt: m.valueFt as number | null,
        valueCount: m.valueCount as number | null,
        itemId: (m.itemId as string | null) || null,
        shape: (m.shape as MeasurementShape["shape"]) || null,
      }));
      setMeasurements(parsed);
    } catch {
      // non-fatal — worst case the just-recomputed values only show up
      // after the next full page load
    }
  }, [id]);

  // Load extraction metadata and measurements
  useEffect(() => {
    const load = async () => {
      try {
        // Fetch extraction, measurements, and (if ?item= param) the target
        // placeholder item in parallel.
        const fetches: Array<Promise<Response>> = [
          fetch(`/api/extractions/${id}`),
          fetch(`/api/extractions/${id}/measurements`),
        ];
        if (targetItemId) {
          fetches.push(fetch(`/api/items/${targetItemId}`));
        }
        const results = await Promise.all(fetches);
        const [extRes, measRes, itemRes] = results;

        if (extRes.ok) {
          const data = await extRes.json();
          setExtraction(data);
        }

        if (measRes.ok) {
          const { measurements: meas } = await measRes.json();
          const parsed = meas.map((m: Record<string, unknown>) => ({
            id: m.id as string,
            type: m.type as string,
            points: JSON.parse(m.pointsJson as string) as Point[],
            page: m.page as number,
            color: m.color as string,
            label: m.label as string | undefined,
            valueFt: m.valueFt as number | null,
            valueCount: m.valueCount as number | null,
            itemId: (m.itemId as string | null) || null,
            shape: (m.shape as MeasurementShape["shape"]) || null,
          }));
          setMeasurements(parsed);
          undoStack.current = parsed.map((m: MeasurementShape) => m.id);
        }

        // If a target item was requested, store it for the "Add to items"
        // promotion flow. Strip the magic suffix to get the clean name.
        if (itemRes && itemRes.ok) {
          const itemData = await itemRes.json();
          const rawName = itemData.name as string;
          const cleanName = rawName.endsWith(MANUAL_MEASURE_SUFFIX)
            ? rawName.slice(0, -MANUAL_MEASURE_SUFFIX.length)
            : rawName;
          setTargetItem({
            id: itemData.id,
            name: cleanName,
            originalName: rawName,
            measurementType: itemData.measurementType,
            system: itemData.system,
            unit: itemData.unit,
            sourceSheetId: itemData.sourceSheetId,
            evidence: itemData.evidence || null,
          });
        } else if (targetItemId && itemRes && !itemRes.ok) {
          console.warn(
            `[measure] Failed to load target item ${targetItemId}: ${itemRes.status}`
          );
          toast.error("Could not load target item for measurement");
        }
      } catch (err) {
        console.error("Failed to load measurement data:", err);
        toast.error("Failed to load measurement data");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id, targetItemId]);

  const handleCanvasReady = useCallback(
    (_canvas: HTMLCanvasElement, pdfW: number, pdfH: number) => {
      setPdfDimensions({ width: pdfW, height: pdfH });
      pdfDimensionsRef.current = { width: pdfW, height: pdfH };
    },
    []
  );

  // If opened via "Measure" button from the inventory (?item=<id>),
  // pre-select the correct tool once the target item has loaded and the
  // scale has been calibrated (you can't draw measurements without a scale).
  useEffect(() => {
    if (!targetItem || !extraction) return;
    if (!isPageCalibrated(currentPage)) return;
    setActiveTool(targetItem.measurementType as ToolMode);
  }, [targetItem, extraction, currentPage, isPageCalibrated]);

  // === AI Auto-Scale: detect scale bar when no scale is set ===
  const handleAutoScale = useCallback(async () => {
    if (!extraction || autoScaleLoading) return;
    setAutoScaleLoading(true);
    const toastId = toast.loading("Detecting scale bar...");
    try {
      const res = await fetch("/api/analyze/scale-bar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extractionId: id }),
      });
      const data = await res.json();
      // The route returns 400/500 with an `error` field (bad/missing API
      // key, no PDF stored, provider failure, etc.) — that response has no
      // `found` field, so it used to fall straight into the generic "not
      // found" toast below, silently hiding the actual reason detection
      // never ran at all.
      if (!res.ok) {
        throw new Error(data.error || "Scale detection failed");
      }
      if (data.found) {
        setAutoScaleResult(data);
        toast.dismiss(toastId);
        toast.success(`Scale detected: ${data.notation}`);
      } else {
        toast.dismiss(toastId);
        toast.info("Could not detect scale bar. Please calibrate manually.");
      }
    } catch (err) {
      toast.dismiss(toastId);
      toast.error(err instanceof Error ? err.message : "Scale detection failed");
    } finally {
      setAutoScaleLoading(false);
    }
  }, [extraction, id, autoScaleLoading]);

  // NOTE: Auto-Scale is user-triggered via toolbar "Auto" button.
  // Auto-triggering on load was removed because rendering pages server-side
  // blocks the client PDF viewer from loading.

  // Apply AI-detected scale via existing calibrate endpoint
  const applyAutoScale = async (autoCreateDimensionLine = true, applyToAllPages = false) => {
    if (!autoScaleResult) return;
    try {
      const res = await fetch(`/api/extractions/${id}/calibrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page: autoScaleResult.page,
          points: [autoScaleResult.barStart, autoScaleResult.barEnd],
          distanceFt: autoScaleResult.barLengthFeet,
          pdfWidth: pdfDimensions.width,
          pdfHeight: pdfDimensions.height,
          applyToAllPages,
        }),
      });
      if (!res.ok) throw new Error("Calibration failed");
      const data = await res.json();
      setExtraction((prev) => {
        if (!prev) return prev;
        if (applyToAllPages) {
          return { ...prev, scalePixelsPerFoot: data.pixelsPerFoot };
        }
        let perPage: Record<string, number> = {};
        if (prev.scalePerPageJson) {
          try {
            perPage = JSON.parse(prev.scalePerPageJson);
          } catch {
            perPage = {};
          }
        }
        perPage[String(autoScaleResult.page)] = data.pixelsPerFoot;
        return { ...prev, scalePerPageJson: JSON.stringify(perPage) };
      });
      toast.success(
        `Scale calibrated${applyToAllPages ? " for all pages" : ` for page ${autoScaleResult.page}`}: ${data.scaleDescription}`
      );
      refreshMeasurements();

      if (autoCreateDimensionLine) {
        handleMeasurementComplete(
          "linear",
          [autoScaleResult.barStart, autoScaleResult.barEnd],
          autoScaleResult.page,
          { name: "Scale Reference", color: "#00AA00" },
          true
        );
      }

      if (pendingToolAfterScaleRef.current) {
        // User had clicked Area/Linear/Count before scale was ready — pick
        // up where they left off instead of the generic fallbacks below.
        resumePendingToolIfAny();
      } else if (targetItem) {
        // Auto-select the right tool if we have a target item
        setActiveTool(targetItem.measurementType as ToolMode);
      } else {
        setActiveTool("linear");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Calibration failed");
    } finally {
      setAutoScaleResult(null);
    }
  };

  // === Keyboard shortcuts ===
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      // Space to pan
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setIsSpaceDown(true);
        return;
      }

      // Ctrl+Z: undo
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        // First try to undo last active point
        if (canvasRef.current?.undoLastPoint()) return;
        // Otherwise undo last completed measurement
        const lastId = undoStack.current[undoStack.current.length - 1];
        if (lastId) handleDelete(lastId);
        return;
      }

      // Enter: finish measurement
      if (e.key === "Enter") {
        canvasRef.current?.finishMeasurement();
        return;
      }

      // Escape: cancel or deselect
      if (e.key === "Escape") {
        canvasRef.current?.clearActivePoints();
        setSelectedId(null);
        setActiveTool("select");
        setPendingPlaceholder(null);
        return;
      }

      // Delete/Backspace: delete selected
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId) {
          e.preventDefault();
          handleDelete(selectedId);
        }
        return;
      }

      // Tool shortcuts
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const isCalibrated = isPageCalibrated(currentPage);
        switch (e.key.toLowerCase()) {
          case "v": setActiveTool("select"); break;
          case "r": setActiveTool("calibrate"); break;
          case "l":
            if (isCalibrated) setActiveTool("linear");
            else toast.warning("Set the plan scale first before measuring.");
            break;
          case "a":
            if (isCalibrated) setActiveTool("area");
            else toast.warning("Set the plan scale first before measuring.");
            break;
          case "c":
            if (isCalibrated) setActiveTool("count");
            else toast.warning("Set the plan scale first before measuring.");
            break;
          case "+": case "=": zoomTo(Math.min(5, zoomRef.current + 0.25)); break;
          case "-": zoomTo(Math.max(0.25, zoomRef.current - 0.25)); break;
          case "[": setCurrentPage((p) => Math.max(1, p - 1)); break;
          case "]": setCurrentPage((p) => Math.min(pageCount || 999, p + 1)); break;
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpaceDown(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, extraction, pageCount, currentPage]);

  // Calibration flow. If the Scale dialog's Standard tab was used first, the
  // distance is already known (pendingScaleSettings) — apply immediately
  // instead of asking for it again. Otherwise (e.g. "R" shortcut without the
  // dialog) fall back to the plain distance-entry dialog.
  const handleCalibrationComplete = useCallback(
    (points: [Point, Point]) => {
      if (pendingScaleSettings) {
        runCalibration(
          points,
          pendingScaleSettings.distanceFt,
          pendingScaleSettings.autoCreateDimensionLine,
          pendingScaleSettings.applyToAllPages
        );
        setPendingScaleSettings(null);
        return;
      }
      setCalibrationPoints(points);
      setShowCalibrationDialog(true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingScaleSettings]
  );

  // Shared calibration submit — posts the two points + known distance to the
  // calibrate endpoint, then optionally draws a dimension line for the
  // segment that was used to set the scale. `applyToAllPages` mirrors the
  // Scale dialog's checkbox: when false (the default for the plain "R"
  // shortcut fallback below), the scale is stored per-page instead of
  // overwriting the extraction's global scale.
  const runCalibration = async (
    points: [Point, Point],
    distFt: number,
    autoCreateDimensionLine: boolean,
    applyToAllPages: boolean
  ) => {
    try {
      const res = await fetch(`/api/extractions/${id}/calibrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page: currentPage,
          points,
          distanceFt: distFt,
          pdfWidth: pdfDimensions.width,
          pdfHeight: pdfDimensions.height,
          applyToAllPages,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Calibration failed");
      }

      const data = await res.json();
      setExtraction((prev) => {
        if (!prev) return prev;
        if (applyToAllPages) {
          return { ...prev, scalePixelsPerFoot: data.pixelsPerFoot };
        }
        let perPage: Record<string, number> = {};
        if (prev.scalePerPageJson) {
          try {
            perPage = JSON.parse(prev.scalePerPageJson);
          } catch {
            perPage = {};
          }
        }
        perPage[String(currentPage)] = data.pixelsPerFoot;
        return { ...prev, scalePerPageJson: JSON.stringify(perPage) };
      });
      toast.success(
        `Scale calibrated${applyToAllPages ? " for all pages" : ` for page ${currentPage}`}: ${data.scaleDescription}`
      );
      refreshMeasurements();

      if (autoCreateDimensionLine) {
        handleMeasurementComplete(
          "linear",
          points,
          currentPage,
          { name: "Scale Reference", color: "#00AA00" },
          true
        );
      }

      if (pendingToolAfterScaleRef.current) {
        // User had clicked Area/Linear/Count before scale was ready — pick
        // up where they left off instead of the generic Linear fallback.
        resumePendingToolIfAny();
      } else {
        setActiveTool("linear");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Calibration failed");
    } finally {
      // The two clicked points were held on-canvas (not auto-cleared) so the
      // line stayed visible through the distance-entry/apply flow above —
      // now that calibration has resolved (success or failure), clear it.
      canvasRef.current?.clearActivePoints();
    }
  };

  const submitCalibration = async () => {
    if (!calibrationPoints || !calibrationDistance) return;
    const distFt = parseFloat(calibrationDistance);
    if (!distFt || distFt <= 0) {
      toast.error("Enter a valid distance in feet");
      return;
    }
    // autoCreateDimensionLine=true — matches the Scale dialog's own default,
    // so a scale reference line always shows on canvas after calibrating,
    // regardless of which of the two calibration entry points was used.
    await runCalibration(calibrationPoints, distFt, true, false);
    setShowCalibrationDialog(false);
    setCalibrationPoints(null);
    setCalibrationDistance("");
  };

  // Create measurement. `styleOverride` lets callers other than the Linear
  // tool (e.g. the Scale dialog's "create dimension line" option) attach
  // their own label/color instead of inheriting whatever the Linear
  // Properties dialog was last set to.
  const handleMeasurementComplete = useCallback(
    async (
      type: "linear" | "area" | "count",
      points: Point[],
      page: number,
      styleOverride?: MeasurementStyle,
      skipCalibrationCheck = false
    ) => {
      // Guard at the actual creation boundary, not just at tool-selection
      // time — activeTool doesn't reset on page navigation, so setting scale
      // on page 2, selecting Linear there (passing the toolbar's gate), then
      // navigating to an uncalibrated page 3 and drawing would otherwise
      // slip straight through with no check at all.
      //
      // skipCalibrationCheck exists for the Scale Reference dimension line:
      // it's created immediately after calibration succeeds, in the same
      // tick as the setExtraction() call that stores the new scale — React
      // hasn't re-rendered with that update yet, so isPageCalibrated(page)
      // here would still read the pre-calibration (stale) state and wrongly
      // reject it. The caller already knows calibration just succeeded, so
      // there's nothing to actually verify.
      if (!skipCalibrationCheck && !isPageCalibrated(page)) {
        toast.warning(`Set the plan scale for page ${page} first before measuring.`);
        setActiveTool("select");
        return;
      }
      try {
        const style =
          styleOverride ??
          (type === "linear" ? linearStyle : type === "count" ? countStyle : type === "area" ? areaStyle : null);
        const res = await fetch(`/api/extractions/${id}/measurements`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            points,
            page,
            ...(style && style.color !== "none" ? { label: style.name, color: style.color } : {}),
            ...(type === "count" && style?.shape ? { shape: style.shape } : {}),
          }),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to save measurement");
        }

        const m = await res.json();
        const newShape: MeasurementShape = {
          id: m.id,
          type: m.type,
          points: JSON.parse(m.pointsJson),
          page: m.page,
          color: m.color,
          label: m.label,
          valueFt: m.valueFt,
          valueCount: m.valueCount,
          itemId: m.itemId || null,
          shape: m.shape || null,
        };
        setMeasurements((prev) => [...prev, newShape]);
        undoStack.current.push(m.id);

        // Finished drawing what the pending-placeholder row was tracking —
        // drop the placeholder and select the real measurement instead, so
        // its dot turns from green (in progress) to red (selected).
        setPendingPlaceholder((prev) =>
          prev && prev.type === type && prev.page === page ? null : prev
        );
        setSelectedId(m.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save measurement");
      }
    },
    [id, linearStyle, countStyle, areaStyle, isPageCalibrated]
  );

  // Delete measurement
  const handleDelete = useCallback(
    async (measurementId: string) => {
      try {
        const res = await fetch(`/api/measurements/${measurementId}`, {
          method: "DELETE",
        });
        if (res.ok) {
          setMeasurements((prev) => prev.filter((m) => m.id !== measurementId));
          undoStack.current = undoStack.current.filter((id) => id !== measurementId);
          if (selectedId === measurementId) setSelectedId(null);
        }
      } catch {
        toast.error("Failed to delete measurement");
      }
    },
    [selectedId]
  );

  // Update measurement label
  const handleLabelChange = useCallback(
    async (measurementId: string, label: string) => {
      try {
        const res = await fetch(`/api/measurements/${measurementId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        });
        if (res.ok) {
          setMeasurements((prev) =>
            prev.map((m) => (m.id === measurementId ? { ...m, label: label || undefined } : m))
          );
        }
      } catch {
        toast.error("Failed to update label");
      }
    },
    []
  );

  // Add measurement to extraction items.
  //
  // Two flows:
  //
  // (a) Normal flow (no ?item= param): creates a brand-new item and links
  //     the measurement to it.
  //
  // (b) Placeholder promotion flow (?item=<id> present): PATCHes the
  //     existing placeholder item to strip the " - MEASURE MANUALLY" suffix,
  //     set the measured quantity, bump confidence to high, and annotate
  //     the evidence field. Then links the measurement to the promoted row.
  //     No new item is created.
  const handleAddToItems = useCallback(
    async (measurementId: string, data: AddToItemsData) => {
      try {
        let itemId: string;

        if (targetItem) {
          // Promote the existing placeholder.
          const cleanName = data.name.endsWith(MANUAL_MEASURE_SUFFIX)
            ? data.name.slice(0, -MANUAL_MEASURE_SUFFIX.length)
            : data.name;
          const sourcePage = measurements.find((m) => m.id === measurementId)?.page;
          const patchRes = await fetch(`/api/items/${targetItem.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: cleanName,
              quantity: data.quantity,
              confidence: "high",
              quantityMethod: "scale_estimate",
              evidence: `Measured manually on ${new Date().toISOString().slice(0, 10)} via measurement tool (measurement ${measurementId}).`,
              // Fill in the page it was actually measured on if the
              // placeholder didn't already have one from AI extraction.
              ...(sourcePage != null && !targetItem.sourceSheetId
                ? { sourcePages: JSON.stringify([sourcePage]) }
                : {}),
            }),
          });
          if (!patchRes.ok) {
            const err = await patchRes.json();
            throw new Error(err.error || "Failed to update placeholder item");
          }
          itemId = targetItem.id;
          // Update local state so the banner disappears — the target is no
          // longer a placeholder.
          setTargetItem(null);
          // Also update the extraction's own items snapshot so this item's
          // row disappears from the AI-pending list in the sidebar right
          // away, instead of waiting for a full reload.
          setExtraction((prev) =>
            prev?.items
              ? {
                  ...prev,
                  items: prev.items.map((it) =>
                    it.id === targetItem.id ? { ...it, name: cleanName, quantity: data.quantity } : it
                  ),
                }
              : prev
          );
        } else {
          // Normal flow: create a new item.
          const sourcePage = measurements.find((m) => m.id === measurementId)?.page;
          const itemRes = await fetch("/api/items", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              extractionId: id,
              name: data.name,
              measurementType: data.measurementType,
              system: data.system,
              quantity: data.quantity,
              quantityMethod: "scale_estimate",
              sourcePages: sourcePage != null ? JSON.stringify([sourcePage]) : undefined,
            }),
          });
          if (!itemRes.ok) {
            const err = await itemRes.json();
            throw new Error(err.error || "Failed to create item");
          }
          const newItem = await itemRes.json();
          itemId = newItem.id;
        }

        // Link the measurement to the item (new or promoted)
        const linkRes = await fetch(`/api/measurements/${measurementId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId }),
        });

        if (linkRes.ok) {
          setMeasurements((prev) =>
            prev.map((m) => (m.id === measurementId ? { ...m, itemId } : m))
          );
        }

        toast.success(
          targetItem
            ? `Promoted "${data.name}" (${data.quantity.toFixed(2)} ${targetItem.unit}) — you can close this tab now`
            : `Added "${data.name}" to items`
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add item");
      }
    },
    [id, targetItem, measurements]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[80vh]">
        <p className="text-muted-foreground">Loading measurement tool...</p>
      </div>
    );
  }

  if (!extraction) {
    return (
      <div className="flex items-center justify-center h-[80vh]">
        <p className="text-red-500">Extraction not found</p>
      </div>
    );
  }

  const pdfUrl = `/api/extractions/${id}/pdf`;
  const isManualMode = extraction.provider === "manual";
  const isCalibrated = isPageCalibrated(currentPage);
  const ppf = ppfForPage(currentPage);
  const selectedMeasurement = measurements.find((m) => m.id === selectedId) ?? null;

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      {/* Target item banner — shown when opened via "Measure" button on a placeholder */}
      {targetItem && (
        <div className="px-4 py-2 bg-yellow-50 border-b border-yellow-200 text-sm shrink-0">
          <div className="flex items-center gap-3">
            <span className="text-lg">📐</span>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-yellow-900">
                Measuring: {targetItem.name}
              </div>
              <div className="text-xs text-yellow-800">
                Draw the{" "}
                <span className="font-medium">{targetItem.measurementType}</span>{" "}
                on the plan using the tools at left, then click{" "}
                <span className="font-medium">&quot;Add to items&quot;</span> to
                link the measurement to this row and update its quantity.
                {targetItem.sourceSheetId && (
                  <> Source sheet: <span className="font-mono">{targetItem.sourceSheetId}</span>.</>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b bg-background shrink-0">
        <Button variant="ghost" size="sm" onClick={() => router.push(`/extractions/${id}`)}>
          ← Back
        </Button>
        <h2 className="font-semibold text-sm truncate flex-1">{extraction.name} — Manually</h2>
        {/* Instructions bar */}
        <div className="text-xs text-muted-foreground bg-muted/50 px-3 py-1 rounded">
          {toolInstructions[activeTool]}
        </div>
      </div>

      {/* Ribbon toolbar */}
      <MeasurementToolbar
        activeTool={activeTool}
        onToolChange={setActiveTool}
        isCalibrated={isCalibrated}
        scaleDescription={
          ppf ? `Scale: 1px = ${(1 / ppf).toFixed(4)} ft` : undefined
        }
        // Auto-Scale ribbon button disabled — the Scale dialog's Auto tab
        // covers AI scale detection instead.
        onScaleClick={() => setShowScaleDialog(true)}
        onScalePending={(tool) => {
          pendingToolAfterScaleRef.current = tool;
        }}
        onAreaClick={() => {
          setActiveTool("area");
          setShowAreaProperties(true);
        }}
        onLinearClick={() => {
          setActiveTool("linear");
          setShowLinearProperties(true);
        }}
        onCountClick={() => {
          setActiveTool("count");
          setShowCountProperties(true);
        }}
        onPrevPage={() => setCurrentPage((p) => Math.max(1, p - 1))}
        onNextPage={() => setCurrentPage((p) => Math.min(pageCount || p, p + 1))}
        canPrevPage={currentPage > 1}
        canNextPage={pageCount === 0 || currentPage < pageCount}
        zoom={zoom}
        onZoomIn={() => zoomTo(Math.min(10, zoomRef.current + 0.1))}
        onZoomOut={() => zoomTo(Math.max(0.1, zoomRef.current - 0.1))}
        onFitPage={fitPage}
        onZoomSet={(z) => zoomTo(Math.min(10, z))}
      />

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Sheet list sidebar */}
        <SheetListSidebar
          extractionId={id}
          extractionName={extraction.name}
          pageCount={pageCount}
          currentPage={currentPage}
          onPageSelect={setCurrentPage}
          measurements={measurements}
          selectedId={selectedId}
          aiPendingItems={aiItems}
          onAiItemSelect={(item) => {
            setCurrentPage(item.page);
            if (!item.needsMeasurement) {
              // Already quantified by AI — just jump to its page for
              // reference, no promotion flow to run.
              return;
            }
            setTargetItem({
              id: item.id,
              name: item.name,
              originalName: item.originalName,
              measurementType: item.measurementType,
              system: item.system,
              unit: item.unit,
              sourceSheetId: item.sourceSheetId,
              evidence: item.evidence,
            });
            // Tool auto-selects once the target page's calibration check
            // passes — see the targetItem effect keyed on currentPage below.
          }}
          onMeasurementSelect={(m) => {
            setSelectedId(m.id);
            setCurrentPage(m.page);

            // Center the canvas view on this measurement so it's visible,
            // zooming in a bit if the current zoom is too far out to see it.
            const xs = m.points.map((p) => p.x);
            const ys = m.points.map((p) => p.y);
            const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
            const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
            const cw = viewportDimsRef.current.width;
            const ch = viewportDimsRef.current.height;
            const targetZoom = Math.max(zoom, 1.2);
            setZoom(targetZoom);
            setPanOffset({
              x: cw / 2 - cx * targetZoom,
              y: ch / 2 - cy * targetZoom,
            });
          }}
          onMeasurementDropOnPage={(m, targetPage) => {
            // Carry the dragged item's name/color/shape over to that tool's
            // persistent style, then jump to the target page with the tool
            // active so the user can continue placing more of the same kind
            // — the original item on its source page is left untouched.
            const style: MeasurementStyle = {
              name: m.label || m.type,
              color: m.color,
              ...(m.type === "count" ? { shape: m.shape ?? "circle" } : {}),
            };
            if (m.type === "linear") setLinearStyle(style);
            else if (m.type === "count") setCountStyle(style);
            else if (m.type === "area") setAreaStyle(style);

            setCurrentPage(targetPage);
            setActiveTool(m.type as ToolMode);
            // Clear any stale selection — otherwise a previously-selected
            // row stays highlighted (red dot) at the same time as the new
            // pending row (green dot), which reads as two things being
            // "active" at once.
            setSelectedId(null);
            setPendingPlaceholder({ type: m.type, page: targetPage, label: style.name, color: style.color });
            toast.info(`Continue placing "${style.name}" on page ${targetPage}`);
          }}
          pendingPlaceholder={pendingPlaceholder}
        />

        {/* PDF Viewer + Canvas Overlay (overlay rendered inside PdfViewer) */}
        <div
          className="flex-1 relative min-w-0"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(MEASUREMENT_DRAG_MIME)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDrop={(e) => {
            const raw = e.dataTransfer.getData(MEASUREMENT_DRAG_MIME);
            if (!raw) return;
            e.preventDefault();
            let dragged: { type: "linear" | "area" | "count"; label?: string; color: string; shape?: MeasurementShape["shape"] };
            try {
              dragged = JSON.parse(raw);
            } catch {
              return;
            }

            const style: MeasurementStyle = {
              name: dragged.label || dragged.type,
              color: dragged.color,
              ...(dragged.type === "count" ? { shape: dragged.shape ?? "circle" } : {}),
            };
            if (dragged.type === "linear") setLinearStyle(style);
            else if (dragged.type === "count") setCountStyle(style);
            else if (dragged.type === "area") setAreaStyle(style);

            // Even Count needs a follow-up click to actually place the
            // marker — dropping onto the canvas only sets up the tool/style,
            // it doesn't place anything by itself, same as Linear/Area. This
            // also means where you drop doesn't matter, only where you
            // subsequently click, so there's no need to compute a drop point.
            setActiveTool(dragged.type);
            setSelectedId(null);
            setPendingPlaceholder({ type: dragged.type, page: currentPage, label: style.name, color: style.color });
            toast.info(
              dragged.type === "count"
                ? `Click to place "${style.name}"`
                : `Click to start drawing "${style.name}"`
            );
          }}
        >
          <PdfViewer
            pdfUrl={pdfUrl}
            currentPage={currentPage}
            onPageChange={setCurrentPage}
            zoom={zoom}
            onZoomChange={setZoom}
            panOffset={panOffset}
            onPanOffsetChange={setPanOffset}
            onCanvasReady={handleCanvasReady}
            onPageCountReady={handlePageCountReady}
            activeTool={activeTool}
            isSpaceDown={isSpaceDown}
            textHighlights={combinedTextHighlights}
            hideNavBar
            renderOverlay={(w, h) => {
              viewportDimsRef.current = { width: w, height: h };
              return (
              <MeasurementCanvas
                ref={canvasRef}
                width={w}
                height={h}
                zoom={zoom}
                panOffset={panOffset}
                activeTool={activeTool}
                currentPage={currentPage}
                measurements={measurements}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMeasurementComplete={(type, points, page) => {
                  // Clear the one-off "View on PDF" text highlights when the
                  // user starts measuring — the AI-item highlights (always on
                  // per page, see combinedTextHighlights) are left alone.
                  if (textHighlights.length > 0) setTextHighlights([]);
                  handleMeasurementComplete(type, points, page);
                }}
                onCalibrationComplete={handleCalibrationComplete}
                onPanOffsetChange={(offset) => setPanOffset(clampPanOffset(offset, zoomRef.current))}
                linearColor={linearStyle.color !== "none" ? linearStyle.color : "#FF4444"}
                areaColor={areaStyle.color !== "none" ? areaStyle.color : "#FF4444"}
                pixelsPerFoot={ppf}
                isSpaceDown={isSpaceDown}
                onCursorMove={(pos) => {
                  cursorPosRef.current = pos;
                }}
              />
              );
            }}
          />

          {/* Floating rename / Add to Items / delete popover for the selected measurement */}
          {selectedMeasurement && selectedMeasurement.page === currentPage && (
            <MeasurementFloatingActions
              measurement={selectedMeasurement}
              anchor={{
                x: selectedMeasurement.points[0].x * zoom + panOffset.x,
                y: selectedMeasurement.points[0].y * zoom + panOffset.y - 36,
              }}
              onLabelChange={(label) => handleLabelChange(selectedMeasurement.id, label)}
              onDelete={() => handleDelete(selectedMeasurement.id)}
              onAddToItems={(data) => handleAddToItems(selectedMeasurement.id, data)}
            />
          )}

        </div>
      </div>

      {/* Calibration Dialog */}
      {showCalibrationDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background rounded-lg p-6 shadow-lg max-w-sm w-full mx-4">
            <h3 className="font-semibold mb-2">Set Scale</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Enter the real-world distance between the two points you clicked (in feet).
            </p>
            <Input
              type="number"
              step="any"
              placeholder="e.g., 40"
              value={calibrationDistance}
              onChange={(e) => setCalibrationDistance(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitCalibration()}
              autoFocus
            />
            <div className="flex gap-2 mt-4">
              <Button
                variant="outline"
                onClick={() => {
                  setShowCalibrationDialog(false);
                  setCalibrationPoints(null);
                  setCalibrationDistance("");
                  canvasRef.current?.clearActivePoints();
                }}
              >
                Cancel
              </Button>
              <Button onClick={submitCalibration}>Set Scale</Button>
            </div>
          </div>
        </div>
      )}

      {/* Scale setup dialog — PlanSwift-style "Scale" popup */}
      <ScaleDialog
        open={showScaleDialog}
        onClose={() => {
          setShowScaleDialog(false);
          setAutoScaleResult(null);
        }}
        onConfirmStandard={({ distanceFt, applyToAllPages, autoCreateDimensionLine }) => {
          setPendingScaleSettings({ distanceFt, applyToAllPages, autoCreateDimensionLine });
          setShowScaleDialog(false);
          setActiveTool("calibrate");
          toast.info(`Now click the two endpoints of that ${distanceFt.toFixed(2)} ft distance on the plan.`);
        }}
        onConfirmAuto={(_detected, applyToAllPages, autoCreateDimensionLine) => {
          setShowScaleDialog(false);
          applyAutoScale(autoCreateDimensionLine, applyToAllPages);
        }}
        onDetectAuto={handleAutoScale}
        autoScaleLoading={autoScaleLoading}
        autoScaleResult={autoScaleResult}
        hideAutoTab={isManualMode}
      />

      {/* Area tool properties — PlanSwift-style "Properties - [Area]" popup */}
      <PropertiesDialog
        open={showAreaProperties}
        toolLabel="Area"
        value={areaStyle}
        onClose={() => setShowAreaProperties(false)}
        onConfirm={(style) => {
          setAreaStyle(style);
          setShowAreaProperties(false);
          setActiveTool("area");
        }}
      />

      {/* Linear tool properties — PlanSwift-style "Properties - [Linear]" popup */}
      <PropertiesDialog
        open={showLinearProperties}
        toolLabel="Linear"
        value={linearStyle}
        onClose={() => setShowLinearProperties(false)}
        onConfirm={(style) => {
          setLinearStyle(style);
          setShowLinearProperties(false);
          setActiveTool("linear");
        }}
      />

      {/* Count tool properties — PlanSwift-style "Properties - [New Count]" popup */}
      <PropertiesDialog
        open={showCountProperties}
        toolLabel="New Count"
        value={countStyle}
        showShape
        onClose={() => setShowCountProperties(false)}
        onConfirm={(style) => {
          setCountStyle(style);
          setShowCountProperties(false);
          setActiveTool("count");
        }}
      />
    </div>
  );
}
