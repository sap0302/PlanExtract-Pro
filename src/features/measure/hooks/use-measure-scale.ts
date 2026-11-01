"use client";

import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { toast } from "sonner";
import type { Point } from "@/lib/measurement-utils";
import { withPageScale } from "../lib/scale";
import type { ExtractionData, PendingScaleSettings, TargetItem } from "../types";
import type { MeasurementCanvasHandle } from "../components/measurement-canvas";
import type { MeasurementStyle } from "../components/properties-dialog";
import type { ToolMode } from "../components/measurement-toolbar";

export function useMeasureScale(opts: {
  extractionId: string;
  currentPage: number;
  pdfWidth: number;
  pdfHeight: number;
  extraction: ExtractionData | null;
  targetItem: TargetItem | null;
  canvasRef: RefObject<MeasurementCanvasHandle | null>;
  setExtraction: Dispatch<SetStateAction<ExtractionData | null>>;
  refreshMeasurements: () => Promise<void>;
  setActiveTool: (tool: ToolMode) => void;
  resumePendingToolIfAny: () => void;
  pendingToolAfterScaleRef: { current: "area" | "linear" | "count" | null };
  onCreateDimensionLine: (
    type: "linear",
    points: Point[],
    page: number,
    style: MeasurementStyle,
    skipCalibrationCheck: boolean
  ) => void;
}) {
  const {
    extractionId,
    currentPage,
    pdfWidth,
    pdfHeight,
    extraction,
    targetItem,
    canvasRef,
    setExtraction,
    refreshMeasurements,
    setActiveTool,
    resumePendingToolIfAny,
    pendingToolAfterScaleRef,
    onCreateDimensionLine,
  } = opts;

  const [showScaleDialog, setShowScaleDialog] = useState(false);
  const [showCalibrationDialog, setShowCalibrationDialog] = useState(false);
  const [calibrationPoints, setCalibrationPoints] = useState<[Point, Point] | null>(null);
  const [calibrationDistance, setCalibrationDistance] = useState("");
  const [pendingScaleSettings, setPendingScaleSettings] = useState<PendingScaleSettings | null>(
    null
  );
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

  const handleAutoScale = useCallback(async () => {
    if (!extraction || autoScaleLoading) return;
    setAutoScaleLoading(true);
    const toastId = toast.loading("Detecting scale bar...");
    try {
      const res = await fetch("/api/analyze/scale-bar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extractionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Scale detection failed");
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
  }, [autoScaleLoading, extraction, extractionId]);

  const runCalibration = async (
    points: [Point, Point],
    distFt: number,
    autoCreateDimensionLine: boolean,
    applyToAllPages: boolean,
    page = currentPage
  ) => {
    try {
      const res = await fetch(`/api/extractions/${extractionId}/calibrate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page,
          points,
          distanceFt: distFt,
          pdfWidth,
          pdfHeight,
          applyToAllPages,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Calibration failed");
      }
      const data = await res.json();
      setExtraction((prev) => (prev ? withPageScale(prev, page, data.pixelsPerFoot, applyToAllPages) : prev));
      toast.success(
        `Scale calibrated${applyToAllPages ? " for all pages" : ` for page ${page}`}: ${data.scaleDescription}`
      );
      refreshMeasurements();
      if (autoCreateDimensionLine) {
        onCreateDimensionLine("linear", points, page, { name: "Scale Reference", color: "#00AA00" }, true);
      }
      if (pendingToolAfterScaleRef.current) resumePendingToolIfAny();
      else if (targetItem) setActiveTool(targetItem.measurementType as ToolMode);
      else setActiveTool("linear");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Calibration failed");
    } finally {
      canvasRef.current?.clearActivePoints();
    }
  };

  const applyAutoScale = async (autoCreateDimensionLine = true, applyToAllPages = false) => {
    if (!autoScaleResult) return;
    await runCalibration(
      [autoScaleResult.barStart, autoScaleResult.barEnd],
      autoScaleResult.barLengthFeet,
      autoCreateDimensionLine,
      applyToAllPages,
      autoScaleResult.page
    );
    setAutoScaleResult(null);
  };

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

  const submitCalibration = async () => {
    if (!calibrationPoints || !calibrationDistance) return;
    const distFt = parseFloat(calibrationDistance);
    if (!distFt || distFt <= 0) {
      toast.error("Enter a valid distance in feet");
      return;
    }
    await runCalibration(calibrationPoints, distFt, true, false);
    setShowCalibrationDialog(false);
    setCalibrationPoints(null);
    setCalibrationDistance("");
  };

  const cancelCalibration = () => {
    setShowCalibrationDialog(false);
    setCalibrationPoints(null);
    setCalibrationDistance("");
    canvasRef.current?.clearActivePoints();
  };

  const confirmStandardScale = (settings: PendingScaleSettings) => {
    setPendingScaleSettings(settings);
    setShowScaleDialog(false);
    setActiveTool("calibrate");
    toast.info(
      `Now click the two endpoints of that ${settings.distanceFt.toFixed(2)} ft distance on the plan.`
    );
  };

  return {
    showScaleDialog,
    setShowScaleDialog,
    showCalibrationDialog,
    calibrationDistance,
    setCalibrationDistance,
    autoScaleLoading,
    autoScaleResult,
    setAutoScaleResult,
    handleAutoScale,
    applyAutoScale,
    handleCalibrationComplete,
    submitCalibration,
    cancelCalibration,
    confirmStandardScale,
  };
}
