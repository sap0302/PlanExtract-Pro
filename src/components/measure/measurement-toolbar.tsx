"use client";

import { Button } from "@/components/ui/button";

export type ToolMode = "select" | "calibrate" | "linear" | "area" | "count";

interface MeasurementToolbarProps {
  activeTool: ToolMode;
  onToolChange: (tool: ToolMode) => void;
  isCalibrated: boolean;
  scaleDescription?: string;
  onAutoScale?: () => void;
  autoScaleLoading?: boolean;
}

// SVG icons for each tool
function SelectIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z" />
      <path d="M13 13l6 6" />
    </svg>
  );
}

function CalibrateIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12h4" />
      <path d="M18 12h4" />
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <rect x="6" y="6" width="12" height="12" rx="1" />
      <path d="M9 12h6" />
      <path d="M6 9l3 3-3 3" />
      <path d="M18 9l-3 3 3 3" />
    </svg>
  );
}

function LinearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 20 10 8 16 14 20 4" />
      <circle cx="4" cy="20" r="2" fill="currentColor" />
      <circle cx="20" cy="4" r="2" fill="currentColor" />
    </svg>
  );
}

function AreaIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="4 18 8 4 20 6 18 20" fill="currentColor" fillOpacity="0.1" />
      <polygon points="4 18 8 4 20 6 18 20" />
      <circle cx="4" cy="18" r="1.5" fill="currentColor" />
      <circle cx="8" cy="4" r="1.5" fill="currentColor" />
      <circle cx="20" cy="6" r="1.5" fill="currentColor" />
      <circle cx="18" cy="20" r="1.5" fill="currentColor" />
    </svg>
  );
}

function CountIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" fill="currentColor" />
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
    </svg>
  );
}

const tools: Array<{
  id: ToolMode;
  label: string;
  shortcut: string;
  Icon: () => React.JSX.Element;
  description: string;
  requiresCalibration: boolean;
}> = [
  {
    id: "select",
    label: "Select",
    shortcut: "V",
    Icon: SelectIcon,
    description: "Pan & select",
    requiresCalibration: false,
  },
  {
    id: "calibrate",
    label: "Scale",
    shortcut: "R",
    Icon: CalibrateIcon,
    description: "Set scale",
    requiresCalibration: false,
  },
  {
    id: "linear",
    label: "Linear",
    shortcut: "L",
    Icon: LinearIcon,
    description: "Measure length",
    requiresCalibration: true,
  },
  {
    id: "area",
    label: "Area",
    shortcut: "A",
    Icon: AreaIcon,
    description: "Measure area",
    requiresCalibration: true,
  },
  {
    id: "count",
    label: "Count",
    shortcut: "C",
    Icon: CountIcon,
    description: "Place markers",
    requiresCalibration: false,
  },
];

export function MeasurementToolbar({
  activeTool,
  onToolChange,
  isCalibrated,
  scaleDescription,
  onAutoScale,
  autoScaleLoading,
}: MeasurementToolbarProps) {
  return (
    <div className="flex flex-col gap-1 p-2 border-r bg-muted/30 shrink-0 w-16">
      {tools.map((tool) => {
        const disabled = tool.requiresCalibration && !isCalibrated;
        const isActive = activeTool === tool.id;
        return (
          <button
            key={tool.id}
            className={`flex flex-col items-center gap-0.5 px-1 py-1.5 rounded text-xs transition-colors
              ${isActive ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-muted text-muted-foreground hover:text-foreground"}
              ${disabled ? "opacity-40 pointer-events-none" : "cursor-pointer"}
            `}
            onClick={() => onToolChange(tool.id)}
            disabled={disabled}
            title={`${tool.description} (${tool.shortcut})${disabled ? " — calibrate scale first" : ""}`}
          >
            <tool.Icon />
            <span className="leading-none font-medium">{tool.label}</span>
            <span className="text-[9px] opacity-60 leading-none">{tool.shortcut}</span>
          </button>
        );
      })}

      {/* Auto-Scale button — only visible when not calibrated */}
      {!isCalibrated && onAutoScale && (
        <button
          className={`flex flex-col items-center gap-0.5 px-1 py-1.5 rounded text-xs transition-colors
            ${autoScaleLoading ? "opacity-60 pointer-events-none" : "cursor-pointer hover:bg-blue-100 text-blue-600 hover:text-blue-800"}
          `}
          onClick={onAutoScale}
          disabled={autoScaleLoading}
          title="AI auto-detect scale bar"
        >
          {autoScaleLoading ? (
            <div className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a4 4 0 0 1 4 4c0 1.95-2 4-4 7-2-3-4-5.05-4-7a4 4 0 0 1 4-4z" />
              <circle cx="12" cy="6" r="1" fill="currentColor" />
              <path d="M3 20h18" />
              <path d="M3 17v3" />
              <path d="M21 17v3" />
              <path d="M12 17v3" />
            </svg>
          )}
          <span className="leading-none font-medium">Auto</span>
        </button>
      )}

      {/* Scale indicator */}
      <div className="mt-auto pt-2 border-t text-center">
        {isCalibrated ? (
          <div className="text-[10px] text-green-600 font-semibold leading-tight" title={scaleDescription}>
            ✓ Scale<br />set
          </div>
        ) : (
          <div className="text-[10px] text-amber-600 font-semibold leading-tight">
            ⚠ No<br />scale
          </div>
        )}
      </div>
    </div>
  );
}
