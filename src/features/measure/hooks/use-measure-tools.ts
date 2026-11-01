"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { ToolMode } from "../components/measurement-toolbar";
import type { MeasurementStyle } from "../components/properties-dialog";
import type { PendingPlaceholder } from "../types";

export function useMeasureTools(opts: {
  currentPage: number;
  isPageCalibrated: (page: number) => boolean;
  setCurrentPage: Dispatch<SetStateAction<number>>;
  onOpenScaleDialog: () => void;
}) {
  const { currentPage, isPageCalibrated, setCurrentPage, onOpenScaleDialog } = opts;

  const [activeTool, setActiveTool] = useState<ToolMode>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isSpaceDown, setIsSpaceDown] = useState(false);
  const [pendingPlaceholder, setPendingPlaceholder] = useState<PendingPlaceholder | null>(null);

  const [showLinearProperties, setShowLinearProperties] = useState(false);
  const [linearStyle, setLinearStyle] = useState<MeasurementStyle>({
    name: "Linear",
    color: "#FF0000",
  });
  const [showCountProperties, setShowCountProperties] = useState(false);
  const [countStyle, setCountStyle] = useState<MeasurementStyle>({
    name: "New Count",
    color: "#800080",
    shape: "circle",
    scaled: false,
  });
  const [showAreaProperties, setShowAreaProperties] = useState(false);
  const [areaStyle, setAreaStyle] = useState<MeasurementStyle>({
    name: "Area",
    color: "#4CAF6E",
  });

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

  const rejectDropOnUncalibratedPage = useCallback(
    (page: number, tool: "linear" | "area" | "count"): boolean => {
      if (isPageCalibrated(page)) return false;

      pendingToolAfterScaleRef.current = tool;
      setCurrentPage(page);
      setActiveTool("select");
      setPendingPlaceholder(null);
      toast.warning("Set the plan scale first before measuring.", {
        description: "Area, Linear, and Count all need a scale to produce accurate quantities.",
        action: { label: "Set Scale", onClick: onOpenScaleDialog },
      });
      return true;
    },
    [isPageCalibrated, setCurrentPage, onOpenScaleDialog]
  );

  const applyDroppedStyle = useCallback(
    (style: MeasurementStyle, type: "linear" | "area" | "count") => {
      if (type === "linear") setLinearStyle(style);
      else if (type === "count") setCountStyle(style);
      else setAreaStyle(style);
    },
    []
  );

  // Clicking an existing takeoff in the list makes it the active item: the
  // tool switches to its type and style so the next run or marker is added
  // under the same name instead of starting a new line item.
  const continueWithStyle = useCallback(
    (type: "linear" | "area" | "count", style: MeasurementStyle, page: number): boolean => {
      applyDroppedStyle(style, type);
      if (rejectDropOnUncalibratedPage(page, type)) return false;
      setActiveTool(type);
      setPendingPlaceholder(null);
      return true;
    },
    [applyDroppedStyle, rejectDropOnUncalibratedPage]
  );

  const armDroppedTool = useCallback(
    (type: "linear" | "area" | "count", style: MeasurementStyle, page: number, message: string) => {
      applyDroppedStyle(style, type);
      if (rejectDropOnUncalibratedPage(page, type)) return;
      setCurrentPage(page);
      setActiveTool(type);
      setSelectedId(null);
      setPendingPlaceholder({ type, page, label: style.name, color: style.color });
      toast.info(message);
    },
    [applyDroppedStyle, rejectDropOnUncalibratedPage, setCurrentPage]
  );

  useEffect(() => {
    if (
      (activeTool === "linear" || activeTool === "area" || activeTool === "count") &&
      !isPageCalibrated(currentPage)
    ) {
      setActiveTool("select");
      setPendingPlaceholder(null);
      toast.warning(`Set the plan scale for page ${currentPage} first before measuring.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage]);

  return {
    activeTool,
    setActiveTool,
    selectedId,
    setSelectedId,
    isSpaceDown,
    setIsSpaceDown,
    pendingPlaceholder,
    setPendingPlaceholder,
    linearStyle,
    setLinearStyle,
    countStyle,
    setCountStyle,
    areaStyle,
    setAreaStyle,
    showLinearProperties,
    setShowLinearProperties,
    showCountProperties,
    setShowCountProperties,
    showAreaProperties,
    setShowAreaProperties,
    pendingToolAfterScaleRef,
    openPropertiesFor,
    resumePendingToolIfAny,
    rejectDropOnUncalibratedPage,
    applyDroppedStyle,
    continueWithStyle,
    armDroppedTool,
  };
}
