"use client";

import { useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from "react";
import { toast } from "sonner";
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEP } from "../lib/constants";
import type { MeasurementCanvasHandle } from "../components/measurement-canvas";
import type { ToolMode } from "../components/measurement-toolbar";
import type { PendingPlaceholder } from "../types";

export function useMeasureKeyboard(opts: {
  canvasRef: RefObject<MeasurementCanvasHandle | null>;
  undoStack: MutableRefObject<string[]>;
  selectedId: string | null;
  currentPage: number;
  pageCount: number;
  isPageCalibrated: (page: number) => boolean;
  setCurrentPage: Dispatch<SetStateAction<number>>;
  setActiveTool: (tool: ToolMode) => void;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setPendingPlaceholder: Dispatch<SetStateAction<PendingPlaceholder | null>>;
  setIsSpaceDown: (down: boolean) => void;
  handleDelete: (id: string) => void;
  zoomTo: (zoom: number) => void;
  zoomRef: MutableRefObject<number>;
}) {
  const {
    canvasRef,
    undoStack,
    selectedId,
    currentPage,
    pageCount,
    isPageCalibrated,
    setCurrentPage,
    setActiveTool,
    setSelectedId,
    setPendingPlaceholder,
    setIsSpaceDown,
    handleDelete,
    zoomTo,
    zoomRef,
  } = opts;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setIsSpaceDown(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        if (canvasRef.current?.undoLastPoint()) return;
        const lastId = undoStack.current[undoStack.current.length - 1];
        if (lastId) handleDelete(lastId);
        return;
      }
      if (e.key === "Enter") {
        canvasRef.current?.finishMeasurement();
        return;
      }
      if (e.key === "Escape") {
        canvasRef.current?.clearActivePoints();
        setSelectedId(null);
        setActiveTool("select");
        setPendingPlaceholder(null);
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        if (canvasRef.current?.undoLastPoint()) return;
        if (selectedId) handleDelete(selectedId);
        return;
      }
      if (e.key === "Delete") {
        if (selectedId) {
          e.preventDefault();
          handleDelete(selectedId);
        }
        return;
      }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const calibrated = isPageCalibrated(currentPage);
        switch (e.key.toLowerCase()) {
          case "v":
            setActiveTool("select");
            break;
          case "r":
            setActiveTool("calibrate");
            break;
          case "l":
            if (calibrated) setActiveTool("linear");
            else toast.warning("Set the plan scale first before measuring.");
            break;
          case "a":
            if (calibrated) setActiveTool("area");
            else toast.warning("Set the plan scale first before measuring.");
            break;
          case "c":
            if (calibrated) setActiveTool("count");
            else toast.warning("Set the plan scale first before measuring.");
            break;
          case "+":
          case "=":
            zoomTo(Math.min(MAX_ZOOM, zoomRef.current * ZOOM_STEP));
            break;
          case "-":
            zoomTo(Math.max(MIN_ZOOM, zoomRef.current / ZOOM_STEP));
            break;
          case "[":
            setCurrentPage((p) => Math.max(1, p - 1));
            break;
          case "]":
            setCurrentPage((p) => Math.min(pageCount || 999, p + 1));
            break;
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setIsSpaceDown(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, pageCount, currentPage]);
}
