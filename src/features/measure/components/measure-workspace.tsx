"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";
import { MEASUREMENT_DRAG_MIME } from "./sheet-list-sidebar";
import { SheetListSidebar } from "./sheet-list-sidebar";
import { PdfViewer } from "./pdf-viewer";
import { MeasurementCanvas, type MeasurementCanvasHandle, type MeasurementShape } from "./measurement-canvas";
import { MeasurementFloatingActions } from "./measurement-floating-actions";
import type { ToolMode } from "./measurement-toolbar";
import type { AddToItemsData, AiMeasureItem } from "../types";
import type { Point } from "@/lib/measurement-utils";

export function MeasureWorkspace({
  extractionId,
  extractionName,
  pageCount,
  currentPage,
  setCurrentPage,
  measurements,
  selectedId,
  aiItems,
  onAiItemSelect,
  onSelectMeasurement,
  onSelect,
  isPageCalibrated,
  onDropOnPage,
  onCanvasDrop,
  pendingPlaceholder,
  pdfUrl,
  zoom,
  setZoom,
  panOffset,
  setPanOffset,
  onCanvasReady,
  onPageCountReady,
  activeTool,
  isSpaceDown,
  textHighlights,
  viewportDimsRef,
  canvasRef,
  onMeasurementComplete,
  onCalibrationComplete,
  clampPan,
  linearColor,
  areaColor,
  pixelsPerFoot,
  onCursorMove,
  selectedMeasurement,
  onLabelChange,
  onDelete,
  onAddToItems,
}: {
  extractionId: string;
  extractionName: string;
  pageCount: number;
  currentPage: number;
  setCurrentPage: Dispatch<SetStateAction<number>>;
  measurements: MeasurementShape[];
  selectedId: string | null;
  aiItems: AiMeasureItem[];
  onAiItemSelect: (item: AiMeasureItem) => void;
  onSelectMeasurement: (m: MeasurementShape) => void;
  onSelect: (id: string | null) => void;
  isPageCalibrated: (page: number) => boolean;
  onDropOnPage: (m: MeasurementShape, page: number) => void;
  onCanvasDrop: (payload: {
    type: "linear" | "area" | "count";
    label?: string;
    color: string;
    shape?: MeasurementShape["shape"];
  }) => void;
  pendingPlaceholder: { type: "linear" | "area" | "count"; page: number; label: string; color: string } | null;
  pdfUrl: string;
  zoom: number;
  setZoom: (z: number) => void;
  panOffset: { x: number; y: number };
  setPanOffset: (offset: { x: number; y: number }) => void;
  onCanvasReady: (canvas: HTMLCanvasElement, w: number, h: number) => void;
  onPageCountReady: (count: number) => void;
  activeTool: ToolMode;
  isSpaceDown: boolean;
  textHighlights: string[];
  viewportDimsRef: { current: { width: number; height: number } };
  canvasRef: RefObject<MeasurementCanvasHandle | null>;
  onMeasurementComplete: (type: "linear" | "area" | "count", points: Point[], page: number) => void;
  onCalibrationComplete: (points: [Point, Point]) => void;
  clampPan: (offset: { x: number; y: number }) => { x: number; y: number };
  linearColor: string;
  areaColor: string;
  pixelsPerFoot: number | null;
  onCursorMove: (pos: { x: number; y: number } | null) => void;
  selectedMeasurement: MeasurementShape | null;
  onLabelChange: (label: string) => void;
  onDelete: () => void;
  onAddToItems: (data: AddToItemsData) => void;
}) {
  return (
    <div className="flex flex-1 min-h-0">
      <SheetListSidebar
        extractionId={extractionId}
        extractionName={extractionName}
        pageCount={pageCount}
        currentPage={currentPage}
        onPageSelect={setCurrentPage}
        measurements={measurements}
        selectedId={selectedId}
        aiPendingItems={aiItems}
        onAiItemSelect={onAiItemSelect}
        onMeasurementSelect={onSelectMeasurement}
        isPageCalibrated={isPageCalibrated}
        onMeasurementDropOnPage={onDropOnPage}
        pendingPlaceholder={pendingPlaceholder}
      />

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
          try {
            onCanvasDrop(JSON.parse(raw));
          } catch {
            return;
          }
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
          onCanvasReady={onCanvasReady}
          onPageCountReady={onPageCountReady}
          activeTool={activeTool}
          isSpaceDown={isSpaceDown}
          textHighlights={textHighlights}
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
                onSelect={onSelect}
                onMeasurementComplete={onMeasurementComplete}
                onCalibrationComplete={onCalibrationComplete}
                onPanOffsetChange={(offset) => setPanOffset(clampPan(offset))}
                linearColor={linearColor}
                areaColor={areaColor}
                pixelsPerFoot={pixelsPerFoot}
                isSpaceDown={isSpaceDown}
                onCursorMove={onCursorMove}
              />
            );
          }}
        />

        {selectedMeasurement && selectedMeasurement.page === currentPage && (
          <MeasurementFloatingActions
            measurement={selectedMeasurement}
            anchor={{
              x: selectedMeasurement.points[0].x * zoom + panOffset.x,
              y: selectedMeasurement.points[0].y * zoom + panOffset.y - 36,
            }}
            onLabelChange={onLabelChange}
            onDelete={onDelete}
            onAddToItems={onAddToItems}
          />
        )}
      </div>
    </div>
  );
}
