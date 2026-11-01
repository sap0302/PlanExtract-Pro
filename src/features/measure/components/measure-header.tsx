"use client";

import { Button } from "@/components/ui/button";
import { TOOL_INSTRUCTIONS } from "../lib/constants";
import type { ToolMode } from "./measurement-toolbar";

export function MeasureHeader({
  extractionName,
  activeTool,
  activeItem,
  onBack,
}: {
  extractionName: string;
  activeTool: ToolMode;
  /** Name and color of the takeoff item new runs/markers are being added to. */
  activeItem?: { name: string; color: string } | null;
  onBack: () => void;
}) {
  const isDrawing = activeTool === "linear" || activeTool === "area" || activeTool === "count";

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b bg-background shrink-0">
      <Button variant="ghost" size="sm" onClick={onBack}>
        ← Back
      </Button>
      <h2 className="font-semibold text-sm truncate flex-1">{extractionName} - Manually</h2>
      {isDrawing && activeItem && (
        <div
          className="flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded border max-w-[240px]"
          title={`New ${activeTool} measurements are added to "${activeItem.name}"`}
        >
          <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: activeItem.color }} />
          <span className="truncate">{activeItem.name}</span>
        </div>
      )}
      <div className="text-xs text-muted-foreground bg-muted/50 px-3 py-1 rounded">
        {TOOL_INSTRUCTIONS[activeTool]}
      </div>
    </div>
  );
}
