"use client";

import { useState } from "react";
import { PdfUpload } from "./pdf-upload";
import { ManualUpload } from "./manual-upload";

type Mode = "ai" | "manual" | null;

/** Landing choice for "New Extraction" — AI-driven takeoff vs. manual-only
 * (skip AI entirely, draw/count everything by hand on the measure page). */
export function ExtractionModeSelect() {
  const [mode, setMode] = useState<Mode>(null);

  if (mode === "ai") return <PdfUpload />;
  if (mode === "manual") return <ManualUpload onBack={() => setMode(null)} />;

  return (
    <div className="grid sm:grid-cols-2 gap-4">
      <button
        onClick={() => setMode("ai")}
        className="text-left border rounded-lg p-6 hover:border-primary hover:bg-primary/5 transition-colors"
      >
        <div className="text-2xl mb-2">✨</div>
        <div className="font-semibold text-lg">AI Mode</div>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a plan and let AI read it, extract a full quantity takeoff, and flag
          anything it can&apos;t confidently measure for manual review.
        </p>
      </button>
      <button
        onClick={() => setMode("manual")}
        className="text-left border rounded-lg p-6 hover:border-primary hover:bg-primary/5 transition-colors"
      >
        <div className="text-2xl mb-2">📐</div>
        <div className="font-semibold text-lg">Manual Mode</div>
        <p className="text-sm text-muted-foreground mt-1">
          Skip AI entirely - upload a plan and go straight to the measure tool to draw
          and count every item by hand.
        </p>
      </button>
    </div>
  );
}
