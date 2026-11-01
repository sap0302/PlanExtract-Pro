"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";

export type ToolMode = "select" | "calibrate" | "linear" | "area" | "count";

interface MeasurementToolbarProps {
  activeTool: ToolMode;
  onToolChange: (tool: ToolMode) => void;
  isCalibrated: boolean;
  scaleDescription?: string;
  onAutoScale?: () => void;
  autoScaleLoading?: boolean;
  /** Opens the Scale setup dialog. If omitted, the Scale button falls back to switching to the calibrate tool. */
  onScaleClick?: () => void;
  /** Called when Area/Linear/Count was clicked but scale isn't set yet — lets the page remember which tool to resume (opening its Properties dialog) once scale is actually set. */
  onScalePending?: (tool: "area" | "linear" | "count") => void;
  /** Opens the Area Properties dialog. If omitted, the Area button falls back to switching to the area tool. */
  onAreaClick?: () => void;
  /** Opens the Linear Properties dialog. If omitted, the Linear button falls back to switching to the linear tool. */
  onLinearClick?: () => void;
  /** Opens the Count Properties dialog. If omitted, the Count button falls back to switching to the count tool. */
  onCountClick?: () => void;

  // Navigate group
  onPrevPage: () => void;
  onNextPage: () => void;
  canPrevPage: boolean;
  canNextPage: boolean;

  // Zoom / Pan group
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitPage: () => void;
  /** Sets zoom to an exact level (e.g. from the Zoom button's preset/custom-% popup). */
  onZoomSet?: (zoom: number) => void;
}

// --- Icons -----------------------------------------------------------------

function BackIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}
function FwdIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
function ZoomIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
function FitPageIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M8 3v18" />
    </svg>
  );
}
function ZoomInIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
      <path d="M11 8v6" />
      <path d="M8 11h6" />
    </svg>
  );
}
function ZoomOutIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
      <path d="M8 11h6" />
    </svg>
  );
}
function PanIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 11V6a2 2 0 0 0-4 0v5" />
      <path d="M14 10V4a2 2 0 0 0-4 0v6" />
      <path d="M10 10.5V6a2 2 0 0 0-4 0v8" />
      <path d="M6 14v-1a2 2 0 0 0-4 0v2a8 8 0 0 0 8 8h2a8 8 0 0 0 8-8v-4a2 2 0 0 0-4 0" />
    </svg>
  );
}
function ScaleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12h4" />
      <path d="M18 12h4" />
      <rect x="6" y="6" width="12" height="12" rx="1" />
      <path d="M9 12h6" />
      <path d="M6 9l3 3-3 3" />
      <path d="M18 9l-3 3 3 3" />
    </svg>
  );
}
function DimensionIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17h18" />
      <path d="M3 17v-3" />
      <path d="M21 17v-3" />
    </svg>
  );
}
export function AreaIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24">
      <path
        d="M6 8.5C7 5.5 10 4 13 5c2.5 1 5 0.5 6.5 2.5-0.5 3 0.5 5-1 7.5-1.5 2.5-4 3-7 3.5-3.5 0.5-6-1-7.5-4C3 12 4.5 10 6 8.5z"
        fill="#4CAF6E"
        stroke="#3C9058"
        strokeWidth="0.5"
      />
    </svg>
  );
}
export function LinearIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3B8CE0" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 19 10 7 15 13 20 4" />
    </svg>
  );
}
export function CountIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24">
      <circle cx="9" cy="8.5" r="4.5" fill="#4FA8D8" />
      <circle cx="15.5" cy="15" r="4.5" fill="#4FA8D8" />
    </svg>
  );
}

// --- Building blocks ---------------------------------------------------

function RibbonButton({
  icon,
  label,
  active,
  disabled,
  title,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      className={`flex flex-col items-center justify-center gap-0.5 px-2 py-1 rounded text-[11px] leading-none min-w-[52px] transition-colors
        ${active ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-muted text-foreground"}
        ${disabled ? "opacity-35 pointer-events-none" : "cursor-pointer"}
      `}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {icon}
      <span className="font-medium mt-0.5">{label}</span>
    </button>
  );
}

function RibbonGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center">
      <div className="flex items-end gap-0.5 px-1.5 pt-1 pb-0.5">{children}</div>
      <div className="text-[10px] text-muted-foreground border-t w-full text-center pt-0.5">
        {label}
      </div>
    </div>
  );
}

function RibbonDivider() {
  return <div className="w-px self-stretch bg-border mx-1" />;
}

const ZOOM_PRESETS = [25, 50, 75, 100, 150, 200, 400];

/** Popup panel opened by the "Zoom" ribbon button — preset percentages plus
 * a custom entry, mirroring PlanSwift's zoom dropdown.
 *
 * Rendered via a portal to document.body, anchored to the button's screen
 * position: the ribbon bar has `overflow-x-auto`, which per the CSS overflow
 * spec forces `overflow-y` to compute to `auto` too (not `visible`) — so an
 * absolutely-positioned child stayed clipped to the ribbon's height no
 * matter its own z-index. Escaping to a portal sidesteps that entirely. */
function ZoomMenu({
  anchorRect,
  anchorEl,
  zoom,
  onSelect,
  onClose,
}: {
  anchorRect: DOMRect;
  /** The button wrapper element — clicks on it are ignored here so its own
   * onClick toggle isn't double-fired by this menu's outside-click check. */
  anchorEl: HTMLElement | null;
  zoom: number;
  onSelect: (zoom: number) => void;
  onClose: () => void;
}) {
  const [customValue, setCustomValue] = useState(String(Math.round(zoom * 100)));
  const menuRef = useRef<HTMLDivElement>(null);

  // Handles its own outside-click (rather than the parent doing it) since
  // this renders into a portal — a listener in the parent checking only the
  // anchor wrapper's `contains()` would treat every click inside the portaled
  // menu as "outside" and close it before its own onClick could ever fire.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return;
      onClose();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [anchorEl, onClose]);

  const applyCustom = () => {
    const pct = parseFloat(customValue);
    if (!pct || pct <= 0) return;
    onSelect(pct / 100);
    onClose();
  };

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 w-40 bg-background border rounded-md shadow-lg py-1"
      style={{ left: anchorRect.left, top: anchorRect.bottom + 4 }}
    >
      {ZOOM_PRESETS.map((pct) => (
        <button
          key={pct}
          className={`w-full text-left px-3 py-1 text-sm hover:bg-muted ${
            Math.round(zoom * 100) === pct ? "font-semibold text-primary" : ""
          }`}
          onClick={() => {
            onSelect(pct / 100);
            onClose();
          }}
        >
          {pct}%
        </button>
      ))}
      <div className="border-t mt-1 pt-1 px-2 flex items-center gap-1">
        <input
          type="number"
          className="w-16 h-7 text-sm border rounded px-1 bg-background"
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applyCustom()}
          onClick={(e) => e.stopPropagation()}
        />
        <span className="text-sm text-muted-foreground">%</span>
        <button
          className="ml-auto text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:opacity-90"
          onClick={applyCustom}
        >
          Set
        </button>
      </div>
    </div>,
    document.body
  );
}

export function MeasurementToolbar({
  activeTool,
  onToolChange,
  isCalibrated,
  scaleDescription,
  onAutoScale,
  autoScaleLoading,
  onScaleClick,
  onScalePending,
  onAreaClick,
  onLinearClick,
  onCountClick,
  onPrevPage,
  onNextPage,
  canPrevPage,
  canNextPage,
  zoom,
  onZoomIn,
  onZoomOut,
  onFitPage,
  onZoomSet,
}: MeasurementToolbarProps) {
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const zoomMenuRef = useRef<HTMLDivElement>(null);

  // Area/Linear/Count all need a scale to produce a meaningful measurement
  // (Count technically doesn't need one to place a marker, but items placed
  // before scale is set can't be trusted once it IS set, since nothing
  // retroactively re-measures them) — previously these just silently
  // disabled with no explanation, which reads as broken buttons.
  const requireScale = (pendingTool: "area" | "linear" | "count"): boolean => {
    if (isCalibrated) return true;
    // Remember which tool the user actually wanted, so once they set scale
    // (e.g. via the toast's own "Set Scale" action) the page can pick up
    // where they left off and open that tool's Properties dialog, instead
    // of leaving them to notice scale is set and click the button again.
    onScalePending?.(pendingTool);
    toast.warning("Set the plan scale first before measuring.", {
      description: "Area, Linear, and Count all need a scale to produce accurate quantities.",
      action: onScaleClick ? { label: "Set Scale", onClick: onScaleClick } : undefined,
    });
    return false;
  };

  return (
    <div className="flex items-stretch gap-0 px-2 py-1 border-b bg-muted/30 shrink-0 overflow-x-auto">
      <RibbonGroup label="Navigate">
        <RibbonButton icon={<BackIcon />} label="Back" title="Previous page" onClick={onPrevPage} disabled={!canPrevPage} />
        <RibbonButton icon={<FwdIcon />} label="Fwd" title="Next page" onClick={onNextPage} disabled={!canNextPage} />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Zoom / Pan">
        <div ref={zoomMenuRef} className="relative">
          <RibbonButton
            icon={<ZoomIcon />}
            label="Zoom"
            title={`Current zoom: ${Math.round(zoom * 100)}%`}
            active={showZoomMenu}
            onClick={() => setShowZoomMenu((s) => !s)}
          />
          {showZoomMenu && zoomMenuRef.current && (
            <ZoomMenu
              anchorRect={zoomMenuRef.current.getBoundingClientRect()}
              anchorEl={zoomMenuRef.current}
              zoom={zoom}
              onSelect={(z) => onZoomSet?.(z)}
              onClose={() => setShowZoomMenu(false)}
            />
          )}
        </div>
        <RibbonButton icon={<FitPageIcon />} label="Fit Page" title="Fit page (reset zoom)" onClick={onFitPage} />
        <RibbonButton icon={<ZoomInIcon />} label="Zoom In" title="Zoom in  +" onClick={onZoomIn} />
        <RibbonButton icon={<ZoomOutIcon />} label="Zoom Out" title="Zoom out  -" onClick={onZoomOut} />
        <RibbonButton
          icon={<PanIcon />}
          label="Pan"
          title="Pan tool  (hold Space or select)"
          active={activeTool === "select"}
          onClick={() => onToolChange("select")}
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Measure">
        <RibbonButton
          icon={<ScaleIcon />}
          label="Scale"
          title="Set the plan scale  (R)"
          active={activeTool === "calibrate"}
          onClick={() => (onScaleClick ? onScaleClick() : onToolChange("calibrate"))}
        />
        <RibbonButton
          icon={<DimensionIcon />}
          label="Dimension"
          title={isCalibrated ? scaleDescription : "Set scale first"}
          disabled
        />
      </RibbonGroup>

      <RibbonDivider />

      <RibbonGroup label="Takeoff">
        <RibbonButton
          icon={<AreaIcon />}
          label="Area"
          title="Measure area  (A)"
          active={activeTool === "area"}
          onClick={() => {
            if (!requireScale("area")) return;
            if (onAreaClick) onAreaClick();
            else onToolChange("area");
          }}
        />
        <RibbonButton
          icon={<LinearIcon />}
          label="Linear"
          title="Measure length  (L)"
          active={activeTool === "linear"}
          onClick={() => {
            if (!requireScale("linear")) return;
            if (onLinearClick) onLinearClick();
            else onToolChange("linear");
          }}
        />
        <RibbonButton
          icon={<CountIcon />}
          label="Count"
          title="Place count markers  (C)"
          active={activeTool === "count"}
          onClick={() => {
            if (!requireScale("count")) return;
            if (onCountClick) onCountClick();
            else onToolChange("count");
          }}
        />
      </RibbonGroup>

      {!isCalibrated && onAutoScale && (
        <>
          <RibbonDivider />
          <RibbonGroup label="AI">
            <RibbonButton
              icon={
                autoScaleLoading ? (
                  <div className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a4 4 0 0 1 4 4c0 1.95-2 4-4 7-2-3-4-5.05-4-7a4 4 0 0 1 4-4z" />
                    <circle cx="12" cy="6" r="1" fill="currentColor" />
                    <path d="M3 20h18" />
                  </svg>
                )
              }
              label="Auto Scale"
              title="AI auto-detect scale bar"
              disabled={autoScaleLoading}
              onClick={onAutoScale}
            />
          </RibbonGroup>
        </>
      )}

      <div className="ml-auto flex items-center gap-1.5 pr-1">
        {isCalibrated ? (
          <>
            <span className="text-[11px] text-green-600 font-semibold whitespace-nowrap">
              ✓ Scale set
            </span>
            {scaleDescription && (
              <span className="text-[11px] text-muted-foreground whitespace-nowrap" title={scaleDescription}>
                {scaleDescription}
              </span>
            )}
          </>
        ) : (
          <span className="text-[11px] text-amber-600 font-semibold whitespace-nowrap">
            ⚠ No scale
          </span>
        )}
      </div>
    </div>
  );
}
