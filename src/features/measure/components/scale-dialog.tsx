"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ScaleDialogResult {
  distanceFt: number;
  applyToAllPages: boolean;
  autoCreateDimensionLine: boolean;
}

interface AutoScaleResult {
  notation: string;
  barLengthFeet: number;
  page: number;
  confidence: number;
}

interface ScaleDialogProps {
  open: boolean;
  onClose: () => void;
  /** Standard tab: user typed a known distance — start the "click two points" flow. */
  onConfirmStandard: (result: ScaleDialogResult) => void;
  /** Auto tab: AI-detected scale bar, apply it directly. */
  onConfirmAuto: (
    detected: AutoScaleResult,
    applyToAllPages: boolean,
    autoCreateDimensionLine: boolean
  ) => void;
  onDetectAuto: () => void;
  autoScaleLoading: boolean;
  autoScaleResult: AutoScaleResult | null;
  /** Manual Mode extractions have no AI involvement anywhere — hides the
   * "Auto" (AI scale-bar detection) tab entirely, leaving only the manual
   * Standard tab. */
  hideAutoTab?: boolean;
}

export function ScaleDialog({
  open,
  onClose,
  onConfirmStandard,
  onConfirmAuto,
  onDetectAuto,
  autoScaleLoading,
  autoScaleResult,
  hideAutoTab,
}: ScaleDialogProps) {
  const [tab, setTab] = useState<"standard" | "auto">("standard");
  const [feet, setFeet] = useState("");
  const [inch, setInch] = useState("");
  const [numerator, setNumerator] = useState("");
  const [denominator, setDenominator] = useState("");
  const [applyToAllPages, setApplyToAllPages] = useState(false);
  // On by default — shows the reference line the scale was set from.
  const [autoCreateDimensionLine, setAutoCreateDimensionLine] = useState(true);

  if (!open) return null;

  const feetNum = parseFloat(feet) || 0;
  const inchNum = parseFloat(inch) || 0;
  const num = parseFloat(numerator) || 0;
  const den = parseFloat(denominator) || 0;
  const fractionInches = den > 0 ? num / den : 0;
  const totalInches = inchNum + fractionInches;
  const totalFeet = feetNum + totalInches / 12;

  const displayInches = Math.round(totalInches);
  const displayLabel = `${feetNum}'${displayInches}"`;

  const handleOk = () => {
    if (tab === "auto") {
      if (autoScaleResult) {
        onConfirmAuto(autoScaleResult, applyToAllPages, autoCreateDimensionLine);
      }
      return;
    }
    if (totalFeet <= 0) return;
    onConfirmStandard({ distanceFt: totalFeet, applyToAllPages, autoCreateDimensionLine });
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-background border rounded-md shadow-xl w-[340px] overflow-hidden">
        {/* Title bar */}
        <div className="bg-primary/90 text-primary-foreground px-3 py-1.5 flex items-center justify-between text-sm font-medium">
          <span>Scale</span>
          <button onClick={onClose} className="hover:opacity-70">
            ✕
          </button>
        </div>

        {/* Tabs */}
        {!hideAutoTab && (
          <div className="flex border-b px-2 pt-2 gap-1">
            <button
              className={`px-3 py-1.5 text-sm rounded-t border-b-2 ${
                tab === "standard"
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground"
              }`}
              onClick={() => setTab("standard")}
            >
              Standard
            </button>
            <button
              className={`px-3 py-1.5 text-sm rounded-t border-b-2 ${
                tab === "auto"
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground"
              }`}
              onClick={() => setTab("auto")}
            >
              Auto
            </button>
          </div>
        )}

        <div className="p-4 space-y-4">
          {(hideAutoTab || tab === "standard") ? (
            <>
              <p className="text-xs text-muted-foreground">
                Enter a known distance, then click its two endpoints on the plan.
              </p>
              <div className="flex items-end gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-muted-foreground">Feet</label>
                  <Input
                    className="w-16 text-center"
                    value={feet}
                    onChange={(e) => setFeet(e.target.value.replace(/[^\d.]/g, ""))}
                  />
                </div>
                <span className="pb-2 text-muted-foreground">&apos;</span>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-muted-foreground">Inch</label>
                  <Input
                    className="w-16 text-center"
                    value={inch}
                    onChange={(e) => setInch(e.target.value.replace(/[^\d.]/g, ""))}
                  />
                </div>
                <span className="pb-2 text-muted-foreground">&quot;</span>
                <div className="flex flex-col gap-1 ml-2">
                  <label className="text-xs font-medium text-muted-foreground text-center">
                    Fraction
                  </label>
                  <div className="flex flex-col gap-0.5 items-center">
                    <Input
                      className="w-12 h-6 text-center text-xs"
                      value={numerator}
                      onChange={(e) => setNumerator(e.target.value.replace(/[^\d]/g, ""))}
                    />
                    <div className="w-12 border-t" />
                    <Input
                      className="w-12 h-6 text-center text-xs"
                      value={denominator}
                      onChange={(e) => setDenominator(e.target.value.replace(/[^\d]/g, ""))}
                    />
                  </div>
                </div>
              </div>

              <div className="text-lg font-semibold">{displayLabel}</div>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Let AI find a printed scale bar on the current page.
              </p>
              {autoScaleResult ? (
                <div className="rounded border bg-muted/40 p-2 text-sm space-y-1">
                  <div className="font-medium">{autoScaleResult.notation}</div>
                  <div className="text-xs text-muted-foreground">
                    Scale bar: {autoScaleResult.barLengthFeet} FT on page {autoScaleResult.page}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Confidence: {((autoScaleResult.confidence ?? 0) * 100).toFixed(0)}%
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onDetectAuto}
                  disabled={autoScaleLoading}
                >
                  {autoScaleLoading ? "Detecting..." : "Detect Scale Bar"}
                </Button>
              )}
            </>
          )}

          <div className="space-y-2 pt-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={applyToAllPages}
                onChange={(e) => setApplyToAllPages(e.target.checked)}
              />
              Apply Scale to all pages.
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoCreateDimensionLine}
                onChange={(e) => setAutoCreateDimensionLine(e.target.checked)}
              />
              Automatically create dimension line
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t bg-muted/20">
          <Button
            size="sm"
            onClick={handleOk}
            disabled={tab === "standard" ? totalFeet <= 0 : !autoScaleResult}
          >
            ✓ Ok
          </Button>
          <Button size="sm" variant="outline" onClick={onClose}>
            ✕ Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
