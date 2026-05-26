"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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
import { MeasurementPanel, type AddToItemsData } from "@/components/measure/measurement-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import type { Point } from "@/lib/measurement-utils";
import { decodeSnippetsFromUrl } from "@/lib/evidence-snippets";

interface ExtractionData {
  id: string;
  name: string;
  scalePixelsPerFoot: number | null;
  scaleCalibrationJson: string | null;
  pageCount: number | null;
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

  const [extraction, setExtraction] = useState<ExtractionData | null>(null);
  const [measurements, setMeasurements] = useState<MeasurementShape[]>([]);
  const [targetItem, setTargetItem] = useState<TargetItem | null>(null);
  const [loading, setLoading] = useState(true);

  // Viewer state
  const [currentPage, setCurrentPage] = useState(initialPage);
  // Text-search highlights pulled from the URL (?snippets=...) — passed to
  // PdfViewer which finds them on the current page via getTextContent and
  // draws yellow boxes. Setting to [] hides all highlights.
  const [textHighlights, setTextHighlights] = useState<string[]>(initialSnippets);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [activeTool, setActiveTool] = useState<ToolMode>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSpaceDown, setIsSpaceDown] = useState(false);

  // PDF dimensions (reported by PdfViewer on render)
  const [pdfDimensions, setPdfDimensions] = useState({ width: 0, height: 0 });

  // Undo stack: stores measurement IDs in creation order
  const undoStack = useRef<string[]>([]);

  // Calibration dialog
  const [showCalibrationDialog, setShowCalibrationDialog] = useState(false);
  const [calibrationPoints, setCalibrationPoints] = useState<[Point, Point] | null>(null);
  const [calibrationDistance, setCalibrationDistance] = useState("");

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
  const [showAutoScaleConfirm, setShowAutoScaleConfirm] = useState(false);

  // AI region highlighting
  const [highlights, setHighlights] = useState<Array<{
    bbox: [number, number, number, number];
    label: string;
    confidence: number;
    page: number;
  }>>([]);
  const [regionLoading, setRegionLoading] = useState(false);

  // Page count from extraction
  const pageCount = extraction?.pageCount ?? 0;

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
    },
    []
  );

  // If opened via "Measure" button from the inventory (?item=<id>),
  // pre-select the correct tool once the target item has loaded and the
  // scale has been calibrated (you can't draw measurements without a scale).
  useEffect(() => {
    if (!targetItem || !extraction) return;
    const isCal = extraction.scalePixelsPerFoot != null && extraction.scalePixelsPerFoot > 0;
    if (!isCal) return;
    setActiveTool(targetItem.measurementType as ToolMode);
  }, [targetItem, extraction]);

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
      if (data.found) {
        setAutoScaleResult(data);
        setShowAutoScaleConfirm(true);
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
  const applyAutoScale = async () => {
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
        }),
      });
      if (!res.ok) throw new Error("Calibration failed");
      const data = await res.json();
      setExtraction((prev) =>
        prev ? { ...prev, scalePixelsPerFoot: data.pixelsPerFoot } : prev
      );
      toast.success(`Scale calibrated: ${data.scaleDescription}`);
      // Auto-select the right tool if we have a target item
      if (targetItem) {
        setActiveTool(targetItem.measurementType as ToolMode);
      } else {
        setActiveTool("linear");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Calibration failed");
    } finally {
      setShowAutoScaleConfirm(false);
      setAutoScaleResult(null);
    }
  };

  // === AI Region Highlighting: user-triggered item location ===
  const handleLocateItem = useCallback(async () => {
    if (!targetItem || !extraction || regionLoading) return;
    setRegionLoading(true);
    const toastId = toast.loading(`Finding ${targetItem.name} locations...`);

    try {
      const res = await fetch("/api/analyze/regions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          extractionId: id,
          itemName: targetItem.name,
          itemEvidence: targetItem.evidence,
          measurementType: targetItem.measurementType,
        }),
      });
      const data = await res.json();
      toast.dismiss(toastId);
      if (data.regions?.length) {
        setHighlights(data.regions);
        toast.success(`Found ${data.regions.length} location(s)`);
        if (data.regions[0].page !== currentPage) {
          setCurrentPage(data.regions[0].page);
        }
      } else {
        toast.info("No locations found. Look for the item manually.");
      }
    } catch (err) {
      toast.dismiss(toastId);
      console.warn("[regions] Detection failed:", err);
      toast.error("Location detection failed");
    } finally {
      setRegionLoading(false);
    }
  }, [targetItem, extraction, id, regionLoading, currentPage]);

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
        const isCalibrated = extraction?.scalePixelsPerFoot != null && extraction.scalePixelsPerFoot > 0;
        switch (e.key.toLowerCase()) {
          case "v": setActiveTool("select"); break;
          case "r": setActiveTool("calibrate"); break;
          case "l": if (isCalibrated) setActiveTool("linear"); break;
          case "a": if (isCalibrated) setActiveTool("area"); break;
          case "c": setActiveTool("count"); break;
          case "+": case "=": setZoom((z) => Math.min(5, z + 0.25)); break;
          case "-": setZoom((z) => Math.max(0.25, z - 0.25)); break;
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
  }, [selectedId, extraction, pageCount]);

  // Calibration flow
  const handleCalibrationComplete = useCallback((points: [Point, Point]) => {
    setCalibrationPoints(points);
    setShowCalibrationDialog(true);
  }, []);

  const submitCalibration = async () => {
    if (!calibrationPoints || !calibrationDistance) return;
    const distFt = parseFloat(calibrationDistance);
    if (!distFt || distFt <= 0) {
      toast.error("Enter a valid distance in feet");
      return;
    }

    try {
      const res = await fetch(`/api/extractions/${id}/calibrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page: currentPage,
          points: calibrationPoints,
          distanceFt: distFt,
          pdfWidth: pdfDimensions.width,
          pdfHeight: pdfDimensions.height,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Calibration failed");
      }

      const data = await res.json();
      setExtraction((prev) =>
        prev ? { ...prev, scalePixelsPerFoot: data.pixelsPerFoot } : prev
      );
      toast.success(`Scale calibrated: ${data.scaleDescription}`);
      setActiveTool("linear");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Calibration failed");
    } finally {
      setShowCalibrationDialog(false);
      setCalibrationPoints(null);
      setCalibrationDistance("");
    }
  };

  // Create measurement
  const handleMeasurementComplete = useCallback(
    async (type: "linear" | "area" | "count", points: Point[], page: number) => {
      try {
        const res = await fetch(`/api/extractions/${id}/measurements`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, points, page }),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to save measurement");
        }

        const m = await res.json();
        const shape: MeasurementShape = {
          id: m.id,
          type: m.type,
          points: JSON.parse(m.pointsJson),
          page: m.page,
          color: m.color,
          label: m.label,
          valueFt: m.valueFt,
          valueCount: m.valueCount,
          itemId: m.itemId || null,
        };
        setMeasurements((prev) => [...prev, shape]);
        undoStack.current.push(m.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save measurement");
      }
    },
    [id]
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
          const patchRes = await fetch(`/api/items/${targetItem.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: cleanName,
              quantity: data.quantity,
              confidence: "high",
              quantityMethod: "scale_estimate",
              evidence: `Measured manually on ${new Date().toISOString().slice(0, 10)} via measurement tool (measurement ${measurementId}).`,
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
        } else {
          // Normal flow: create a new item.
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
    [id, targetItem]
  );

  // Page jump from panel click
  const handlePageJump = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

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
  const isCalibrated = extraction.scalePixelsPerFoot !== null && extraction.scalePixelsPerFoot > 0;
  const ppf = extraction.scalePixelsPerFoot;

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
            {/* AI Locate button */}
            <button
              className={`shrink-0 px-3 py-1.5 rounded text-xs font-medium transition-colors
                ${regionLoading
                  ? "bg-yellow-200 text-yellow-700 cursor-wait"
                  : "bg-yellow-400 text-yellow-900 hover:bg-yellow-500 cursor-pointer"
                }`}
              onClick={handleLocateItem}
              disabled={regionLoading}
              title="AI finds where this item is on the plan"
            >
              {regionLoading ? (
                <span className="flex items-center gap-1">
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-yellow-700 border-t-transparent" />
                  Locating...
                </span>
              ) : (
                "🔍 AI Locate"
              )}
            </button>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="flex items-center gap-3 px-4 py-2 border-b bg-background shrink-0">
        <Button variant="ghost" size="sm" onClick={() => router.push(`/extractions/${id}`)}>
          ← Back
        </Button>
        <h2 className="font-semibold text-sm truncate flex-1">{extraction.name} — Measure</h2>
        {/* Instructions bar */}
        <div className="text-xs text-muted-foreground bg-muted/50 px-3 py-1 rounded">
          {toolInstructions[activeTool]}
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Toolbar */}
        <MeasurementToolbar
          activeTool={activeTool}
          onToolChange={setActiveTool}
          isCalibrated={isCalibrated}
          scaleDescription={
            ppf ? `${(1 / ppf).toFixed(4)} ft/px` : undefined
          }
          // Auto-Scale disabled — omit handlers to hide the "Auto" button
          // entirely. Users set scale manually via the Scale tool.
        />

        {/* PDF Viewer + Canvas Overlay (overlay rendered inside PdfViewer) */}
        <div className="flex-1 relative min-w-0">
          <PdfViewer
            pdfUrl={pdfUrl}
            currentPage={currentPage}
            onPageChange={setCurrentPage}
            zoom={zoom}
            onZoomChange={setZoom}
            panOffset={panOffset}
            onPanOffsetChange={setPanOffset}
            onCanvasReady={handleCanvasReady}
            activeTool={activeTool}
            isSpaceDown={isSpaceDown}
            textHighlights={textHighlights}
            renderOverlay={(w, h) => (
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
                  // Clear highlights when user starts measuring
                  if (highlights.length > 0) setHighlights([]);
                  if (textHighlights.length > 0) setTextHighlights([]);
                  handleMeasurementComplete(type, points, page);
                }}
                onCalibrationComplete={handleCalibrationComplete}
                pixelsPerFoot={ppf}
                isSpaceDown={isSpaceDown}
                highlights={highlights.filter((h) => h.page === currentPage)}
                onHighlightClick={(hl) => {
                  const [x1, y1, x2, y2] = hl.bbox;
                  const cx = (x1 + x2) / 2;
                  const cy = (y1 + y2) / 2;
                  const bw = x2 - x1;
                  const bh = y2 - y1;
                  const cw = pdfDimensions.width || 800;
                  const ch = pdfDimensions.height || 600;
                  const fitZoom = Math.min(cw / (bw * 2), ch / (bh * 2), 3);
                  setZoom(fitZoom);
                  setPanOffset({
                    x: cw / 2 - cx * fitZoom,
                    y: ch / 2 - cy * fitZoom,
                  });
                }}
              />
            )}
          />
        </div>

        {/* Measurement Panel */}
        <div className="w-64 shrink-0">
          <MeasurementPanel
            measurements={measurements}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDelete={handleDelete}
            onLabelChange={handleLabelChange}
            onAddToItems={handleAddToItems}
            onPageJump={handlePageJump}
            currentPage={currentPage}
            scaleDescription={
              ppf
                ? `Scale: 1px = ${(1 / ppf).toFixed(3)} ft`
                : "Not calibrated"
            }
          />
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
                }}
              >
                Cancel
              </Button>
              <Button onClick={submitCalibration}>Set Scale</Button>
            </div>
          </div>
        </div>
      )}

      {/* Auto-Scale Confirmation Dialog */}
      {showAutoScaleConfirm && autoScaleResult && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background rounded-lg p-6 shadow-lg max-w-sm w-full mx-4">
            <h3 className="font-semibold mb-2">AI Scale Detection</h3>
            <p className="text-sm text-muted-foreground mb-3">
              AI detected a scale bar on page {autoScaleResult.page}:
            </p>
            <div className="bg-muted rounded p-3 mb-3 space-y-1">
              <div className="text-sm font-medium">{autoScaleResult.notation}</div>
              <div className="text-xs text-muted-foreground">
                Scale bar: {autoScaleResult.barLengthFeet} FT
              </div>
              <div className="text-xs text-muted-foreground">
                Confidence: {((autoScaleResult.confidence ?? 0) * 100).toFixed(0)}%
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setShowAutoScaleConfirm(false);
                  setAutoScaleResult(null);
                  toast.info("Calibrate manually using the Scale tool (R).");
                }}
              >
                Cancel
              </Button>
              <Button onClick={applyAutoScale}>Apply Scale</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
