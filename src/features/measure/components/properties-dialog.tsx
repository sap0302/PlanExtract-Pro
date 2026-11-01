"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface MeasurementStyle {
  name: string;
  color: string;
  shape?: "circle" | "square" | "triangle" | "cross";
  scaled?: boolean;
}

interface PropertiesDialogProps {
  open: boolean;
  toolLabel: string; // e.g. "Linear", "Area", "Count"
  value: MeasurementStyle;
  onClose: () => void;
  onConfirm: (style: MeasurementStyle) => void;
  /** Show the "Shape" dropdown and "Scaled" checkbox — used by the Count tool. */
  showShape?: boolean;
}

// PlanSwift-style swatch grid — rows of common takeoff colors, "None" and
// "More Colors..." (native color picker) at top/bottom.
const SWATCH_ROWS: string[][] = [
  ["#000000", "#7F3F00", "#7F0000", "#007F00", "#00007F", "#004C4C", "#4C4C4C", "#7F7F7F"],
  ["#FF0000", "#FF7F00", "#FFFF00", "#00FF00", "#0000FF", "#7F00FF", "#FF00FF", "#BFBFBF"],
  ["#FF66CC", "#FFB380", "#FFFF99", "#99FF99", "#66FFFF", "#99CCFF", "#CC99FF", "#FFFFFF"],
];

export function PropertiesDialog({
  open,
  toolLabel,
  value,
  onClose,
  onConfirm,
  showShape,
}: PropertiesDialogProps) {
  const [name, setName] = useState(value.name);
  const [color, setColor] = useState(value.color);
  const [shape, setShape] = useState(value.shape ?? "circle");
  const [scaled, setScaled] = useState(value.scaled ?? false);
  const [showSwatches, setShowSwatches] = useState(false);

  // Re-sync from `value` every time the dialog opens, instead of only ever
  // once at first mount — this component instance stays mounted (just
  // rendering null while closed) for the whole page's lifetime, so a
  // mount-once useState would keep showing whatever was last typed/left in
  // it rather than that tool's actual current style.
  useEffect(() => {
    if (!open) return;
    setName(value.name);
    setColor(value.color);
    setShape(value.shape ?? "circle");
    setScaled(value.scaled ?? false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const handleOk = () => {
    onConfirm({ name: name.trim() || toolLabel, color, shape, scaled });
    setShowSwatches(false);
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-background border rounded-md shadow-xl w-[420px] overflow-visible">
        {/* Title bar */}
        <div className="bg-primary/90 text-primary-foreground px-3 py-1.5 flex items-center justify-between text-sm font-medium">
          <span>Properties - [{toolLabel}]</span>
          <button onClick={onClose} className="hover:opacity-70">
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <div className="flex gap-1 mt-1">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
                <Button variant="outline" size="sm" className="px-2" tabIndex={-1}>
                  …
                </Button>
              </div>
            </div>

            {showShape && (
              <div>
                <label className="text-xs font-medium text-muted-foreground">Shape</label>
                <select
                  className="mt-1 w-full h-8 border rounded px-2 text-sm bg-background"
                  value={shape}
                  onChange={(e) =>
                    setShape(e.target.value as "circle" | "square" | "triangle" | "cross")
                  }
                >
                  <option value="circle">Circle</option>
                  <option value="square">Square</option>
                  <option value="triangle">Triangle</option>
                  <option value="cross">Cross</option>
                </select>
              </div>
            )}
          </div>

          {showShape && (
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={scaled}
                onChange={(e) => setScaled(e.target.checked)}
              />
              Scaled
            </label>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="relative">
              <label className="text-xs font-medium text-muted-foreground">Color</label>
              <button
                type="button"
                className="mt-1 w-full h-8 border rounded flex items-center justify-between px-2"
                style={{ backgroundColor: color === "none" ? "transparent" : color }}
                onClick={() => setShowSwatches((s) => !s)}
              >
                <span className="sr-only">Pick color</span>
                <span className="ml-auto text-xs bg-white/70 rounded px-1">▾</span>
              </button>

              {showSwatches && (
                <div className="absolute z-10 mt-1 w-56 bg-background border rounded shadow-lg p-2">
                  <button
                    className="w-full text-center text-sm py-1 border-b mb-2 hover:bg-muted"
                    onClick={() => {
                      setColor("none");
                      setShowSwatches(false);
                    }}
                  >
                    None
                  </button>
                  <div className="space-y-1">
                    {SWATCH_ROWS.map((row, i) => (
                      <div key={i} className="flex gap-1">
                        {row.map((c) => (
                          <button
                            key={c}
                            className="w-6 h-6 border rounded-sm"
                            style={{ backgroundColor: c }}
                            onClick={() => {
                              setColor(c);
                              setShowSwatches(false);
                            }}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-xs cursor-pointer hover:bg-muted rounded px-1 py-1">
                    <input
                      type="color"
                      value={color === "none" ? "#FF0000" : color}
                      onChange={(e) => setColor(e.target.value)}
                      className="w-6 h-6 p-0 border-0"
                    />
                    More Colors...
                  </label>
                </div>
              )}
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">Fill Type</label>
              <select
                className="mt-1 w-full h-8 border rounded px-2 text-sm bg-background"
                defaultValue="solid"
              >
                <option value="solid">Solid</option>
              </select>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t bg-muted/20">
          <Button size="sm" onClick={handleOk}>
            Ok
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
