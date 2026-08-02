"use client";

import { useCallback, useState, useEffect, useImperativeHandle, forwardRef, useRef } from "react";
import { Stage, Layer, Line, Circle, Text, Rect, Group, RegularPolygon } from "react-konva";
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
  /** Count-tool marker shape, set via the "Properties - [New Count]" dialog. Defaults to "circle" when unset. */
  shape?: "circle" | "square" | "triangle" | "cross" | null;
}

/** Renders a count marker in the shape chosen in the "Properties - [New Count]" dialog — defaults to a circle when unset (matches pre-shape-support markers). */
function CountMarker({
  shape,
  x,
  y,
  color,
}: {
  shape: MeasurementShape["shape"];
  x: number;
  y: number;
  color: string;
}) {
  switch (shape) {
    case "square":
      return (
        <>
          <Rect x={x - 9} y={y - 9} width={18} height={18} fill={color} opacity={0.8} cornerRadius={2} />
          <Rect x={x - 2.5} y={y - 2.5} width={5} height={5} fill="white" />
        </>
      );
    case "triangle":
      return (
        <>
          <RegularPolygon x={x} y={y} sides={3} radius={12} fill={color} opacity={0.8} />
          <Circle x={x} y={y + 1} radius={2.5} fill="white" />
        </>
      );
    case "cross":
      return (
        <>
          <Rect x={x - 9} y={y - 3} width={18} height={6} fill={color} opacity={0.8} cornerRadius={1} />
          <Rect x={x - 3} y={y - 9} width={6} height={18} fill={color} opacity={0.8} cornerRadius={1} />
        </>
      );
    case "circle":
    default:
      return (
        <>
          <Circle x={x} y={y} radius={10} fill={color} opacity={0.8} />
          <Circle x={x} y={y} radius={3} fill="white" />
        </>
      );
  }
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
  onPanOffsetChange: (offset: { x: number; y: number }) => void;
  /** Stroke color for the linear tool's in-progress preview and its completed measurements — set via the "Properties - [Linear]" dialog. */
  linearColor?: string;
  /** Stroke color for the area tool's in-progress preview — set via drag-and-drop-carried style or a future "Properties - [Area]" dialog. */
  areaColor?: string;
  pixelsPerFoot: number | null;
  isSpaceDown: boolean;
  /** Reports the live cursor position in container-space pixels (same space as `width`/`height`) — null when the cursor leaves the canvas. Used by the parent to zoom-to-cursor from the ribbon buttons. */
  onCursorMove?: (pos: Point | null) => void;
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
      onPanOffsetChange,
      linearColor,
      areaColor,
      pixelsPerFoot,
      isSpaceDown,
      onCursorMove,
    },
    ref
  ) {
    const [activePoints, setActivePoints] = useState<Point[]>([]);
    const [cursorPos, setCursorPos] = useState<Point | null>(null);
    // Raw screen-space (stage) cursor position — used to draw full-span
    // horizontal/vertical guide lines that track the mouse across the canvas.
    const [stagePos, setStagePos] = useState<Point | null>(null);
    // Right-mouse-button panning — the overlay sits on top of the PDF
    // viewer's own container and swallows mouse events whenever a drawing
    // tool is active, so right-click pan has to be implemented here too.
    const isPanningRight = useRef(false);
    const panStart = useRef({ x: 0, y: 0 });
    const [isPanningRightState, setIsPanningRightState] = useState(false);

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
        // Don't handle clicks when panning with space, or from the right/middle
        // mouse button (used exclusively for panning).
        if (isSpaceDown || e.evt.button !== 0) return;

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
            // Deliberately NOT cleared here — the line between the two
            // clicked points should stay visible while the distance
            // dialog/apply flow runs, not vanish the instant the second
            // point is clicked. The parent clears it (via the imperative
            // clearActivePoints ref) once calibration actually resolves —
            // applied, cancelled, or failed.
            onCalibrationComplete([newPoints[0], newPoints[1]] as [Point, Point]);
            setActivePoints(newPoints);
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
        setStagePos({ x: pointer.x, y: pointer.y });
        onCursorMove?.({ x: pointer.x, y: pointer.y });

        if (isPanningRight.current) {
          onPanOffsetChange({
            x: e.evt.clientX - panStart.current.x,
            y: e.evt.clientY - panStart.current.y,
          });
        }
      },
      [stageToLocal, onPanOffsetChange, onCursorMove]
    );

    const handleMouseLeave = useCallback(() => {
      setStagePos(null);
      onCursorMove?.(null);
    }, [onCursorMove]);

    // Right (or middle) mouse button → pan, regardless of the active drawing
    // tool. Left mouse button keeps doing whatever the active tool does.
    const handleStageMouseDown = useCallback(
      (e: KonvaEventObject<MouseEvent>) => {
        if (e.evt.button === 2 || e.evt.button === 1) {
          e.evt.preventDefault();
          isPanningRight.current = true;
          setIsPanningRightState(true);
          panStart.current = {
            x: e.evt.clientX - panOffset.x,
            y: e.evt.clientY - panOffset.y,
          };
        }
      },
      [panOffset]
    );

    const handleStageMouseUp = useCallback(() => {
      isPanningRight.current = false;
      setIsPanningRightState(false);
    }, []);

    // Safety net: if the button is released outside the stage (fast drag),
    // the Stage's own onMouseUp never fires — catch it on the window instead.
    useEffect(() => {
      if (!isPanningRightState) return;
      const stop = () => {
        isPanningRight.current = false;
        setIsPanningRightState(false);
      };
      window.addEventListener("mouseup", stop);
      return () => window.removeEventListener("mouseup", stop);
    }, [isPanningRightState]);

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
    // Guide lines act as the crosshair reticle now, so hide the native cursor
    // while measuring; still show a grab hand while panning (space, select
    // tool, or an active right-mouse-button drag).
    const cursorStyle =
      isPanningRightState || isSpaceDown
        ? "grabbing"
        : activeTool === "select"
        ? "default"
        : "none";

    const activeColor =
      activeTool === "calibrate"
        ? "#0088FF"
        : activeTool === "linear"
        ? linearColor || "#FF4444"
        : activeTool === "area"
        ? areaColor || "#FF4444"
        : "#FF4444";

    return (
      <Stage
        width={width}
        height={height}
        onClick={handleClick}
        onDblClick={handleDblClick}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleStageMouseUp}
        onMouseLeave={handleMouseLeave}
        onContextMenu={(e) => e.evt.preventDefault()}
        style={{ cursor: cursorStyle }}
      >
        <Layer>
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
                  <CountMarker shape={m.shape} x={s.x} y={s.y} color={m.color} />
                </Group>
              );
            }

            return null;
          })}

          {/* Calibration line, held static once both points are placed — no
              longer following the cursor like an in-progress draw, since
              calibration is done at that point and just waiting on the
              distance dialog/apply flow to resolve. */}
          {activeTool === "calibrate" && activePoints.length >= 2 && (
            <Line
              points={flattenPoints([activePoints[0], activePoints[1]])}
              stroke={activeColor}
              strokeWidth={2}
              lineCap="round"
            />
          )}

          {/* Active (in-progress) measurement */}
          {activePoints.length > 0 &&
            cursorPos &&
            !isSpaceDown &&
            !(activeTool === "calibrate" && activePoints.length >= 2) && (
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
              {/* Joint markers — kept for Area so the closing vertex is visible, omitted for Linear (clean stroke only, no dots). */}
              {activeTool === "area" &&
                activePoints.map((p, i) => {
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

        {/* Crosshair guide lines — full-span horizontal/vertical lines that
            track the mouse, rendered on their own layer so they stay above
            everything without participating in hit-testing. A small gap is
            left around the intersection to match the reference reticle. */}
        {stagePos && !isSpaceDown && !isPanningRightState && (
          <Layer listening={false}>
            <Line points={[0, stagePos.y, stagePos.x - 8, stagePos.y]} stroke="black" strokeWidth={1.5} />
            <Line points={[stagePos.x + 8, stagePos.y, width, stagePos.y]} stroke="black" strokeWidth={1.5} />
            <Line points={[stagePos.x, 0, stagePos.x, stagePos.y - 8]} stroke="black" strokeWidth={1.5} />
            <Line points={[stagePos.x, stagePos.y + 8, stagePos.x, height]} stroke="black" strokeWidth={1.5} />
          </Layer>
        )}
      </Stage>
    );
  }
);
