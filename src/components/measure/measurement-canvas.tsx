"use client";

import { useCallback, useState, useEffect, useImperativeHandle, forwardRef } from "react";
import { Stage, Layer, Line, Circle, Text, Rect, Group } from "react-konva";
import type { KonvaEventObject } from "konva/lib/Node";
import type { ToolMode } from "./measurement-toolbar";
import type { Point } from "@/lib/measurement-utils";
import {
  distanceBetween,
  formatMeasurement,
  computePolylineLength,
  computePolygonArea,
} from "@/lib/measurement-utils";

export interface MeasurementShape {
  id: string;
  type: "linear" | "area" | "count";
  points: Point[];
  page: number;
  color: string;
  label?: string;
  valueFt?: number | null;
  valueCount?: number | null;
  itemId?: string | null;
}

export interface MeasurementCanvasHandle {
  undoLastPoint: () => boolean; // returns true if a point was removed
  clearActivePoints: () => void;
  finishMeasurement: () => boolean; // returns true if completed
}

interface MeasurementCanvasProps {
  width: number;
  height: number;
  zoom: number;
  panOffset: { x: number; y: number };
  activeTool: ToolMode;
  currentPage: number;
  measurements: MeasurementShape[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMeasurementComplete: (
    type: "linear" | "area" | "count",
    points: Point[],
    page: number
  ) => void;
  onCalibrationComplete: (points: [Point, Point]) => void;
  pixelsPerFoot: number | null;
  isSpaceDown: boolean;
  // AI region highlights
  highlights?: Array<{
    bbox: [number, number, number, number];
    label: string;
    confidence: number;
    page: number;
  }>;
  onHighlightClick?: (highlight: {
    bbox: [number, number, number, number];
    label: string;
    page: number;
  }) => void;
}

export const MeasurementCanvas = forwardRef<MeasurementCanvasHandle, MeasurementCanvasProps>(
  function MeasurementCanvas(
    {
      width,
      height,
      zoom,
      panOffset,
      activeTool,
      currentPage,
      measurements,
      selectedId,
      onSelect,
      onMeasurementComplete,
      onCalibrationComplete,
      pixelsPerFoot,
      isSpaceDown,
      highlights,
      onHighlightClick,
    },
    ref
  ) {
    const [activePoints, setActivePoints] = useState<Point[]>([]);
    const [cursorPos, setCursorPos] = useState<Point | null>(null);

    // Clear active points when tool changes
    useEffect(() => {
      setActivePoints([]);
    }, [activeTool]);

    // Expose imperative methods for undo/finish from parent
    useImperativeHandle(ref, () => ({
      undoLastPoint: () => {
        if (activePoints.length > 0) {
          setActivePoints((prev) => prev.slice(0, -1));
          return true;
        }
        return false;
      },
      clearActivePoints: () => setActivePoints([]),
      finishMeasurement: () => {
        if (activeTool === "linear" && activePoints.length >= 2) {
          onMeasurementComplete("linear", activePoints, currentPage);
          setActivePoints([]);
          return true;
        }
        if (activeTool === "area" && activePoints.length >= 3) {
          onMeasurementComplete("area", activePoints, currentPage);
          setActivePoints([]);
          return true;
        }
        return false;
      },
    }));

    const stageToLocal = useCallback(
      (stageX: number, stageY: number): Point => ({
        x: (stageX - panOffset.x) / zoom,
        y: (stageY - panOffset.y) / zoom,
      }),
      [zoom, panOffset]
    );

    const localToStage = useCallback(
      (p: Point): Point => ({
        x: p.x * zoom + panOffset.x,
        y: p.y * zoom + panOffset.y,
      }),
      [zoom, panOffset]
    );

    const handleClick = useCallback(
      (e: KonvaEventObject<MouseEvent>) => {
        // Don't handle clicks when panning with space
        if (isSpaceDown) return;

        if (activeTool === "select") {
          onSelect(null);
          return;
        }

        const stage = e.target.getStage();
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const localPoint = stageToLocal(pointer.x, pointer.y);

        if (activeTool === "calibrate") {
          const newPoints = [...activePoints, localPoint];
          if (newPoints.length >= 2) {
            onCalibrationComplete([newPoints[0], newPoints[1]] as [Point, Point]);
            setActivePoints([]);
          } else {
            setActivePoints(newPoints);
          }
          return;
        }

        if (activeTool === "count") {
          onMeasurementComplete("count", [localPoint], currentPage);
          return;
        }

        if (activeTool === "linear") {
          setActivePoints((prev) => [...prev, localPoint]);
          return;
        }

        if (activeTool === "area") {
          if (activePoints.length >= 3) {
            const first = localToStage(activePoints[0]);
            const clickScreen = { x: pointer.x, y: pointer.y };
            if (distanceBetween(first, clickScreen) < 15) {
              onMeasurementComplete("area", activePoints, currentPage);
              setActivePoints([]);
              return;
            }
          }
          setActivePoints((prev) => [...prev, localPoint]);
          return;
        }
      },
      [activeTool, activePoints, currentPage, stageToLocal, localToStage, onSelect, onMeasurementComplete, onCalibrationComplete, isSpaceDown]
    );

    const handleDblClick = useCallback(() => {
      // A double-click also fires handleClick TWICE before this handler runs,
      // adding 1-2 duplicate points at the double-click position. Clean up
      // by removing trailing duplicate points (points within 2px of each other)
      // before finishing the measurement.
      let pts = [...activePoints];
      while (pts.length > 1) {
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        if (Math.abs(last.x - prev.x) < 3 && Math.abs(last.y - prev.y) < 3) {
          pts.pop();
        } else {
          break;
        }
      }

      if (activeTool === "linear" && pts.length >= 2) {
        onMeasurementComplete("linear", pts, currentPage);
        setActivePoints([]);
      } else if (activeTool === "area" && pts.length >= 3) {
        onMeasurementComplete("area", pts, currentPage);
        setActivePoints([]);
      }
    }, [activeTool, activePoints, currentPage, onMeasurementComplete]);

    const handleMouseMove = useCallback(
      (e: KonvaEventObject<MouseEvent>) => {
        const stage = e.target.getStage();
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        setCursorPos(stageToLocal(pointer.x, pointer.y));
      },
      [stageToLocal]
    );

    const flattenPoints = (points: Point[]): number[] =>
      points.flatMap((p) => {
        const s = localToStage(p);
        return [s.x, s.y];
      });

    // Compute live measurement values
    const liveLinearFt = (): number => {
      if (!pixelsPerFoot || activePoints.length === 0 || !cursorPos) return 0;
      return computePolylineLength([...activePoints, cursorPos], pixelsPerFoot);
    };

    const liveAreaSqFt = (): number => {
      if (!pixelsPerFoot || activePoints.length < 2 || !cursorPos) return 0;
      return computePolygonArea([...activePoints, cursorPos], pixelsPerFoot);
    };

    // Readout badge at cursor
    const readoutText = (): string => {
      if (activeTool === "calibrate") {
        return activePoints.length === 0 ? "Click 1st point" : "Click 2nd point";
      }
      if (activeTool === "linear" && pixelsPerFoot) {
        const ft = liveLinearFt();
        if (ft > 0) return `${ft.toFixed(1)} FT`;
        return "Click start point";
      }
      if (activeTool === "area" && pixelsPerFoot) {
        const sq = liveAreaSqFt();
        if (sq > 0) return `${sq.toFixed(1)} SQ FT`;
        if (activePoints.length > 0) return `${activePoints.length} pts`;
        return "Click 1st vertex";
      }
      return "";
    };

    const pageMeasurements = measurements.filter((m) => m.page === currentPage);
    const cursorStyle = isSpaceDown
      ? "grab"
      : activeTool === "select"
      ? "default"
      : "crosshair";

    const activeColor = activeTool === "calibrate" ? "#0088FF" : "#FF4444";

    return (
      <Stage
        width={width}
        height={height}
        onClick={handleClick}
        onDblClick={handleDblClick}
        onMouseMove={handleMouseMove}
        style={{ cursor: cursorStyle }}
      >
        <Layer>
          {/* AI Region Highlights — rendered below measurements */}
          {highlights?.map((h, i) => {
            const topLeft = localToStage({ x: h.bbox[0], y: h.bbox[1] });
            const bottomRight = localToStage({ x: h.bbox[2], y: h.bbox[3] });
            const rectW = bottomRight.x - topLeft.x;
            const rectH = bottomRight.y - topLeft.y;
            return (
              <Group key={`highlight-${i}`}>
                <Rect
                  x={topLeft.x}
                  y={topLeft.y}
                  width={rectW}
                  height={rectH}
                  fill="rgba(255, 200, 0, 0.12)"
                  stroke="#FFB800"
                  strokeWidth={2}
                  dash={[8, 4]}
                  cornerRadius={4}
                  onClick={() => onHighlightClick?.(h)}
                  onTap={() => onHighlightClick?.(h)}
                />
                {/* Label above the highlight */}
                <Rect
                  x={topLeft.x}
                  y={topLeft.y - 18}
                  width={Math.min(h.label.length * 6.5 + 12, rectW + 20)}
                  height={16}
                  fill="rgba(255, 184, 0, 0.9)"
                  cornerRadius={3}
                />
                <Text
                  x={topLeft.x + 6}
                  y={topLeft.y - 16}
                  text={h.label}
                  fontSize={10}
                  fill="#000"
                  width={Math.min(h.label.length * 6.5 + 6, rectW + 14)}
                  ellipsis
                />
              </Group>
            );
          })}

          {/* Existing measurements for current page */}
          {pageMeasurements.map((m) => {
            const isSelected = m.id === selectedId;
            const stagePoints = flattenPoints(m.points);
            const strokeWidth = isSelected ? 3 : 2;

            if (m.type === "linear" && m.points.length >= 2) {
              const midIdx = Math.floor(m.points.length / 2);
              const midStage = localToStage(m.points[midIdx]);
              return (
                <Group key={m.id} onClick={() => onSelect(m.id)}>
                  <Line
                    points={stagePoints}
                    stroke={m.color}
                    strokeWidth={strokeWidth}
                    lineCap="round"
                    lineJoin="round"
                  />
                  {m.points.map((p, i) => {
                    const s = localToStage(p);
                    return <Circle key={i} x={s.x} y={s.y} radius={4} fill={m.color} />;
                  })}
                  {/* Label with background */}
                  <Rect
                    x={midStage.x + 5}
                    y={midStage.y - 22}
                    width={(m.label || formatMeasurement(m.type, m.valueFt ?? null, null)).length * 8 + 8}
                    height={18}
                    fill="white"
                    opacity={0.85}
                    cornerRadius={3}
                  />
                  <Text
                    x={midStage.x + 9}
                    y={midStage.y - 19}
                    text={m.label || formatMeasurement(m.type, m.valueFt ?? null, null)}
                    fontSize={13}
                    fill={m.color}
                    fontStyle="bold"
                  />
                </Group>
              );
            }

            if (m.type === "area" && m.points.length >= 3) {
              const centroid = {
                x: m.points.reduce((s, p) => s + p.x, 0) / m.points.length,
                y: m.points.reduce((s, p) => s + p.y, 0) / m.points.length,
              };
              const cs = localToStage(centroid);
              const label = m.label || formatMeasurement(m.type, m.valueFt ?? null, null);
              return (
                <Group key={m.id} onClick={() => onSelect(m.id)}>
                  <Line points={stagePoints} stroke={m.color} strokeWidth={strokeWidth} closed fill={m.color + "20"} />
                  <Rect x={cs.x - label.length * 4 - 4} y={cs.y - 10} width={label.length * 8 + 8} height={18} fill="white" opacity={0.85} cornerRadius={3} />
                  <Text x={cs.x - label.length * 4} y={cs.y - 7} text={label} fontSize={13} fill={m.color} fontStyle="bold" />
                </Group>
              );
            }

            if (m.type === "count" && m.points.length === 1) {
              const s = localToStage(m.points[0]);
              return (
                <Group key={m.id} onClick={() => onSelect(m.id)}>
                  <Circle x={s.x} y={s.y} radius={10} fill={m.color} opacity={0.8} />
                  <Circle x={s.x} y={s.y} radius={3} fill="white" />
                </Group>
              );
            }

            return null;
          })}

          {/* Active (in-progress) measurement */}
          {activePoints.length > 0 && cursorPos && !isSpaceDown && (
            <>
              <Line
                points={flattenPoints(
                  activeTool === "area" && activePoints.length >= 2
                    ? [...activePoints, cursorPos, activePoints[0]]
                    : [...activePoints, cursorPos]
                )}
                stroke={activeColor}
                strokeWidth={2}
                dash={[6, 3]}
                lineCap="round"
              />
              {activePoints.map((p, i) => {
                const s = localToStage(p);
                return <Circle key={i} x={s.x} y={s.y} radius={5} fill={activeColor} />;
              })}
              {/* Close indicator for area */}
              {activeTool === "area" && activePoints.length >= 3 && (
                <Circle
                  x={localToStage(activePoints[0]).x}
                  y={localToStage(activePoints[0]).y}
                  radius={12}
                  stroke={activeColor}
                  strokeWidth={1}
                  dash={[3, 2]}
                />
              )}
            </>
          )}

          {/* Live readout badge at cursor */}
          {cursorPos && !isSpaceDown && activeTool !== "select" && activeTool !== "count" && (
            (() => {
              const text = readoutText();
              if (!text) return null;
              const cs = localToStage(cursorPos);
              const textW = text.length * 8 + 12;
              return (
                <>
                  <Rect
                    x={cs.x + 14}
                    y={cs.y - 28}
                    width={textW}
                    height={22}
                    fill="rgba(0,0,0,0.8)"
                    cornerRadius={4}
                  />
                  <Text
                    x={cs.x + 20}
                    y={cs.y - 23}
                    text={text}
                    fontSize={14}
                    fill="white"
                    fontStyle="bold"
                  />
                </>
              );
            })()
          )}
        </Layer>
      </Stage>
    );
  }
);
