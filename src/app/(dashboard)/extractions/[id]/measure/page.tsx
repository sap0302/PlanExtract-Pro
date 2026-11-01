"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { decodeSnippetsFromUrl } from "@/lib/evidence-snippets";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  MeasureDialogs,
  MeasureHeader,
  MeasureWorkspace,
  MeasurementToolbar,
  TargetItemBanner,
  ZOOM_STEP,
  isPageCalibrated as pageHasScale,
  nextUnusedColor,
  pixelsPerFootForPage,
  useAiMeasureItems,
  useMeasureActions,
  useMeasureData,
  useMeasureKeyboard,
  useMeasureScale,
  useMeasureTools,
  useMeasureViewport,
  type MeasurementCanvasHandle,
  type MeasurementStyle,
  type ToolMode,
} from "@/features/measure";

export default function MeasurePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const targetItemId = searchParams.get("item");
  const initialPage = (() => {
    const raw = searchParams.get("page");
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 1;
  })();

  const canvasRef = useRef<MeasurementCanvasHandle>(null);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [textHighlights, setTextHighlights] = useState<string[]>(
    decodeSnippetsFromUrl(searchParams.get("snippets"))
  );
  const [livePageCount, setLivePageCount] = useState(0);

  const data = useMeasureData(id, targetItemId);
  const viewport = useMeasureViewport();
  const isPageCalibrated = useCallback(
    (page: number) => pageHasScale(data.extraction, page),
    [data.extraction]
  );
  const openScaleDialogRef = useRef(() => {});
  const tools = useMeasureTools({
    currentPage,
    isPageCalibrated,
    setCurrentPage,
    onOpenScaleDialog: () => openScaleDialogRef.current(),
  });
  const { aiItems, combinedTextHighlights } = useAiMeasureItems(
    data.extraction,
    data.measurements,
    currentPage,
    textHighlights
  );
  const pageCount = livePageCount || data.extraction?.pageCount || 0;

  const actions = useMeasureActions({
    extractionId: id,
    isPageCalibrated,
    linearStyle: tools.linearStyle,
    countStyle: tools.countStyle,
    areaStyle: tools.areaStyle,
    selectedId: tools.selectedId,
    measurements: data.measurements,
    targetItem: data.targetItem,
    undoStack: data.undoStack,
    setActiveTool: tools.setActiveTool,
    setSelectedId: tools.setSelectedId,
    setPendingPlaceholder: tools.setPendingPlaceholder,
    setMeasurements: data.setMeasurements,
    setExtraction: data.setExtraction,
    setTargetItem: data.setTargetItem,
  });

  const scale = useMeasureScale({
    extractionId: id,
    currentPage,
    pdfWidth: viewport.pdfDimensions.width,
    pdfHeight: viewport.pdfDimensions.height,
    extraction: data.extraction,
    targetItem: data.targetItem,
    canvasRef,
    setExtraction: data.setExtraction,
    refreshMeasurements: data.refreshMeasurements,
    setActiveTool: tools.setActiveTool,
    resumePendingToolIfAny: tools.resumePendingToolIfAny,
    pendingToolAfterScaleRef: tools.pendingToolAfterScaleRef,
    onCreateDimensionLine: actions.handleMeasurementComplete,
  });
  openScaleDialogRef.current = () => scale.setShowScaleDialog(true);

  useMeasureKeyboard({
    canvasRef,
    undoStack: data.undoStack,
    selectedId: tools.selectedId,
    currentPage,
    pageCount,
    isPageCalibrated,
    setCurrentPage,
    setActiveTool: tools.setActiveTool,
    setSelectedId: tools.setSelectedId,
    setPendingPlaceholder: tools.setPendingPlaceholder,
    setIsSpaceDown: tools.setIsSpaceDown,
    handleDelete: actions.handleDelete,
    zoomTo: viewport.zoomTo,
    zoomRef: viewport.zoomRef,
  });

  useEffect(() => {
    if (!data.targetItem || !data.extraction) return;
    if (!isPageCalibrated(currentPage)) return;
    tools.setActiveTool(data.targetItem.measurementType as ToolMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.targetItem, data.extraction, currentPage, isPageCalibrated]);

  if (data.loading) {
    return (
      <div className="flex items-center justify-center h-[80vh]">
        <p className="text-muted-foreground">Loading measurement tool...</p>
      </div>
    );
  }

  if (!data.extraction) {
    return (
      <div className="flex items-center justify-center h-[80vh]">
        <p className="text-red-500">Extraction not found</p>
      </div>
    );
  }

  const ppf = pixelsPerFootForPage(data.extraction, currentPage);
  const selectedMeasurement = data.measurements.find((m) => m.id === tools.selectedId) ?? null;

  const styleFromMeasurement = (m: {
    type: "linear" | "area" | "count";
    label?: string;
    color: string;
    shape?: MeasurementStyle["shape"] | null;
  }): MeasurementStyle => ({
    name: m.label || m.type,
    color: m.color,
    ...(m.type === "count" ? { shape: m.shape ?? "circle" } : {}),
  });

  const activeStyle =
    tools.activeTool === "linear"
      ? tools.linearStyle
      : tools.activeTool === "area"
      ? tools.areaStyle
      : tools.activeTool === "count"
      ? tools.countStyle
      : null;

  // New items from the ribbon start on a color no existing takeoff is using.
  const freshColor = () => nextUnusedColor(data.measurements.map((m) => m.color));

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      {data.targetItem && (
        <TargetItemBanner
          name={data.targetItem.name}
          measurementType={data.targetItem.measurementType}
          sourceSheetId={data.targetItem.sourceSheetId}
        />
      )}

      <MeasureHeader
        extractionName={data.extraction.name}
        activeTool={tools.activeTool}
        activeItem={activeStyle && activeStyle.color !== "none" ? activeStyle : null}
        onBack={() => router.push(`/extractions/${id}`)}
      />

      <MeasurementToolbar
        activeTool={tools.activeTool}
        onToolChange={tools.setActiveTool}
        isCalibrated={isPageCalibrated(currentPage)}
        scaleDescription={ppf ? `Scale: 1px = ${(1 / ppf).toFixed(4)} ft` : undefined}
        onScaleClick={() => scale.setShowScaleDialog(true)}
        onScalePending={(tool) => {
          tools.pendingToolAfterScaleRef.current = tool;
        }}
        onAreaClick={() => {
          tools.setAreaStyle((s) => ({ ...s, color: freshColor() }));
          tools.setActiveTool("area");
          tools.setShowAreaProperties(true);
        }}
        onLinearClick={() => {
          tools.setLinearStyle((s) => ({ ...s, color: freshColor() }));
          tools.setActiveTool("linear");
          tools.setShowLinearProperties(true);
        }}
        onCountClick={() => {
          tools.setCountStyle((s) => ({ ...s, color: freshColor() }));
          tools.setActiveTool("count");
          tools.setShowCountProperties(true);
        }}
        onPrevPage={() => setCurrentPage((p) => Math.max(1, p - 1))}
        onNextPage={() => setCurrentPage((p) => Math.min(pageCount || p, p + 1))}
        canPrevPage={currentPage > 1}
        canNextPage={pageCount === 0 || currentPage < pageCount}
        zoom={viewport.zoom}
        onZoomIn={() => viewport.zoomTo(Math.min(MAX_ZOOM, viewport.zoomRef.current * ZOOM_STEP))}
        onZoomOut={() => viewport.zoomTo(Math.max(MIN_ZOOM, viewport.zoomRef.current / ZOOM_STEP))}
        onFitPage={viewport.fitPage}
        onZoomSet={(z) => viewport.zoomTo(Math.min(MAX_ZOOM, z))}
      />

      <MeasureWorkspace
        extractionId={id}
        extractionName={data.extraction.name}
        pageCount={pageCount}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        measurements={data.measurements}
        selectedId={tools.selectedId}
        aiItems={aiItems}
        onAiItemSelect={(item) => {
          setCurrentPage(item.page);
          if (!item.needsMeasurement) return;
          data.setTargetItem({
            id: item.id,
            name: item.name,
            originalName: item.originalName,
            measurementType: item.measurementType,
            system: item.system,
            unit: item.unit,
            sourceSheetId: item.sourceSheetId,
            evidence: item.evidence,
          });
        }}
        onSelectMeasurement={(m) => {
          tools.setSelectedId(m.id);
          setCurrentPage(m.page);
          const xs = m.points.map((p) => p.x);
          const ys = m.points.map((p) => p.y);
          viewport.centerOn(
            (Math.min(...xs) + Math.max(...xs)) / 2,
            (Math.min(...ys) + Math.max(...ys)) / 2
          );
          // Picking a row in the list makes it the active item, so the next
          // run or marker is added under the same name.
          canvasRef.current?.clearActivePoints();
          tools.continueWithStyle(m.type, styleFromMeasurement(m), m.page);
        }}
        onSelect={tools.setSelectedId}
        isPageCalibrated={isPageCalibrated}
        onDropOnPage={(m, page) => {
          const style = styleFromMeasurement(m);
          tools.armDroppedTool(
            m.type,
            style,
            page,
            `Continue placing "${style.name}" on page ${page}`
          );
        }}
        onCanvasDrop={(dragged) => {
          const style = styleFromMeasurement(dragged);
          tools.armDroppedTool(
            dragged.type,
            style,
            currentPage,
            dragged.type === "count"
              ? `Click to place "${style.name}"`
              : `Click to start drawing "${style.name}"`
          );
        }}
        pendingPlaceholder={tools.pendingPlaceholder}
        pdfUrl={`/api/extractions/${id}/pdf`}
        zoom={viewport.zoom}
        setZoom={viewport.setZoom}
        panOffset={viewport.panOffset}
        setPanOffset={viewport.setPanOffset}
        onCanvasReady={viewport.handleCanvasReady}
        onPageCountReady={setLivePageCount}
        activeTool={tools.activeTool}
        isSpaceDown={tools.isSpaceDown}
        textHighlights={combinedTextHighlights}
        viewportDimsRef={viewport.viewportDimsRef}
        canvasRef={canvasRef}
        onMeasurementComplete={(type, points, page) => {
          if (textHighlights.length > 0) setTextHighlights([]);
          actions.handleMeasurementComplete(type, points, page);
        }}
        onCalibrationComplete={scale.handleCalibrationComplete}
        clampPan={(offset) => viewport.clampPanOffset(offset, viewport.zoomRef.current)}
        linearColor={tools.linearStyle.color !== "none" ? tools.linearStyle.color : "#FF4444"}
        areaColor={tools.areaStyle.color !== "none" ? tools.areaStyle.color : "#FF4444"}
        pixelsPerFoot={ppf}
        onCursorMove={(pos) => {
          viewport.cursorPosRef.current = pos;
        }}
        selectedMeasurement={selectedMeasurement}
        onLabelChange={(label) =>
          selectedMeasurement && actions.handleLabelChange(selectedMeasurement.id, label)
        }
        onDelete={() => selectedMeasurement && actions.handleDelete(selectedMeasurement.id)}
        onAddToItems={(payload) =>
          selectedMeasurement && actions.handleAddToItems(selectedMeasurement.id, payload)
        }
      />

      <MeasureDialogs
        showCalibrationDialog={scale.showCalibrationDialog}
        calibrationDistance={scale.calibrationDistance}
        onDistanceChange={scale.setCalibrationDistance}
        onSubmitCalibration={scale.submitCalibration}
        onCancelCalibration={scale.cancelCalibration}
        showScaleDialog={scale.showScaleDialog}
        onCloseScaleDialog={() => {
          scale.setShowScaleDialog(false);
          scale.setAutoScaleResult(null);
        }}
        onConfirmStandard={scale.confirmStandardScale}
        onConfirmAuto={(applyToAllPages, autoCreateDimensionLine) => {
          scale.setShowScaleDialog(false);
          scale.applyAutoScale(autoCreateDimensionLine, applyToAllPages);
        }}
        onDetectAuto={scale.handleAutoScale}
        autoScaleLoading={scale.autoScaleLoading}
        autoScaleResult={scale.autoScaleResult}
        hideAutoTab={data.extraction.provider === "manual"}
        showAreaProperties={tools.showAreaProperties}
        showLinearProperties={tools.showLinearProperties}
        showCountProperties={tools.showCountProperties}
        areaStyle={tools.areaStyle}
        linearStyle={tools.linearStyle}
        countStyle={tools.countStyle}
        onCloseArea={() => tools.setShowAreaProperties(false)}
        onCloseLinear={() => tools.setShowLinearProperties(false)}
        onCloseCount={() => tools.setShowCountProperties(false)}
        onConfirmArea={(style) => {
          tools.setAreaStyle(style);
          tools.setShowAreaProperties(false);
          tools.setActiveTool("area");
        }}
        onConfirmLinear={(style) => {
          tools.setLinearStyle(style);
          tools.setShowLinearProperties(false);
          tools.setActiveTool("linear");
        }}
        onConfirmCount={(style) => {
          tools.setCountStyle(style);
          tools.setShowCountProperties(false);
          tools.setActiveTool("count");
        }}
      />
    </div>
  );
}
