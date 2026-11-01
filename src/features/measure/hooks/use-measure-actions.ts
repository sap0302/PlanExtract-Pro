"use client";

import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { toast } from "sonner";
import { MANUAL_MEASURE_SUFFIX } from "../lib/constants";
import type { AddToItemsData, ExtractionData, TargetItem } from "../types";
import type { MeasurementShape } from "../components/measurement-canvas";
import type { MeasurementStyle } from "../components/properties-dialog";
import type { PendingPlaceholder } from "../types";
import type { ToolMode } from "../components/measurement-toolbar";

export function useMeasureActions(opts: {
  extractionId: string;
  isPageCalibrated: (page: number) => boolean;
  linearStyle: MeasurementStyle;
  countStyle: MeasurementStyle;
  areaStyle: MeasurementStyle;
  selectedId: string | null;
  measurements: MeasurementShape[];
  targetItem: TargetItem | null;
  undoStack: MutableRefObject<string[]>;
  setActiveTool: (tool: ToolMode) => void;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setPendingPlaceholder: Dispatch<SetStateAction<PendingPlaceholder | null>>;
  setMeasurements: Dispatch<SetStateAction<MeasurementShape[]>>;
  setExtraction: Dispatch<SetStateAction<ExtractionData | null>>;
  setTargetItem: Dispatch<SetStateAction<TargetItem | null>>;
}) {
  const {
    extractionId,
    isPageCalibrated,
    linearStyle,
    countStyle,
    areaStyle,
    selectedId,
    measurements,
    targetItem,
    undoStack,
    setActiveTool,
    setSelectedId,
    setPendingPlaceholder,
    setMeasurements,
    setExtraction,
    setTargetItem,
  } = opts;

  const handleMeasurementComplete = useCallback(
    async (
      type: "linear" | "area" | "count",
      points: { x: number; y: number }[],
      page: number,
      styleOverride?: MeasurementStyle,
      skipCalibrationCheck = false
    ) => {
      if (!skipCalibrationCheck && !isPageCalibrated(page)) {
        toast.warning(`Set the plan scale for page ${page} first before measuring.`);
        setActiveTool("select");
        return;
      }
      try {
        const style =
          styleOverride ??
          (type === "linear" ? linearStyle : type === "count" ? countStyle : type === "area" ? areaStyle : null);
        const res = await fetch(`/api/extractions/${extractionId}/measurements`, {
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
        setPendingPlaceholder((prev) =>
          prev && prev.type === type && prev.page === page ? null : prev
        );
        setSelectedId(m.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save measurement");
      }
    },
    [
      extractionId,
      isPageCalibrated,
      linearStyle,
      countStyle,
      areaStyle,
      setActiveTool,
      setMeasurements,
      setPendingPlaceholder,
      setSelectedId,
      undoStack,
    ]
  );

  const handleDelete = useCallback(
    async (measurementId: string) => {
      try {
        const res = await fetch(`/api/measurements/${measurementId}`, { method: "DELETE" });
        if (res.ok) {
          setMeasurements((prev) => prev.filter((m) => m.id !== measurementId));
          undoStack.current = undoStack.current.filter((mid) => mid !== measurementId);
          if (selectedId === measurementId) setSelectedId(null);
        }
      } catch {
        toast.error("Failed to delete measurement");
      }
    },
    [selectedId, setMeasurements, setSelectedId, undoStack]
  );

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
    [setMeasurements]
  );

  const handleAddToItems = useCallback(
    async (measurementId: string, data: AddToItemsData) => {
      try {
        let itemId: string;
        if (targetItem) {
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
          setTargetItem(null);
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
          const sourcePage = measurements.find((m) => m.id === measurementId)?.page;
          const itemRes = await fetch("/api/items", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              extractionId,
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
    [extractionId, measurements, setExtraction, setMeasurements, setTargetItem, targetItem]
  );

  return { handleMeasurementComplete, handleDelete, handleLabelChange, handleAddToItems };
}
