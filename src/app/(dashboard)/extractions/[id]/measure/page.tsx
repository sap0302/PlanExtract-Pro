"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
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

interface ExtractionData {
  id: string;
  name: string;
  scalePixelsPerFoot: number | null;
  scaleCalibrationJson: string | null;
  pageCount: number | null;
}

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
  const canvasRef = useRef<MeasurementCanvasHandle>(null);

  const [extraction, setExtraction] = useState<ExtractionData | null>(null);
  const [measurements, setMeasurements] = useState<MeasurementShape[]>([]);
  const [loading, setLoading] = useState(true);

  // Viewer state
  const [currentPage, setCurrentPage] = useState(1);
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

  // Page count from extraction
  const pageCount = extraction?.pageCount ?? 0;

  // Load extraction metadata and measurements
  useEffect(() => {
    const load = async () => {
      try {
        const [extRes, measRes] = await Promise.all([
          fetch(`/api/extractions/${id}`),
          fetch(`/api/extractions/${id}/measurements`),
        ]);

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
      } catch (err) {
        console.error("Failed to load measurement data:", err);
        toast.error("Failed to load measurement data");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id]);

  const handleCanvasReady = useCallback(
    (_canvas: HTMLCanvasElement, pdfW: number, pdfH: number) => {
      setPdfDimensions({ width: pdfW, height: pdfH });
    },
    []
  );

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

  // Add measurement to extraction items
  const handleAddToItems = useCallback(
    async (measurementId: string, data: AddToItemsData) => {
      try {
        // 1. Create the item
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

        // 2. Link the measurement to the item
        const linkRes = await fetch(`/api/measurements/${measurementId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemId: newItem.id }),
        });

        if (linkRes.ok) {
          setMeasurements((prev) =>
            prev.map((m) => (m.id === measurementId ? { ...m, itemId: newItem.id } : m))
          );
        }

        toast.success(`Added "${data.name}" to items`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to add item");
      }
    },
    [id]
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
                onMeasurementComplete={handleMeasurementComplete}
                onCalibrationComplete={handleCalibrationComplete}
                pixelsPerFoot={ppf}
                isSpaceDown={isSpaceDown}
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
    </div>
  );
}
