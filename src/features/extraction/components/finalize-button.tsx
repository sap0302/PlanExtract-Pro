"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface FinalizeButtonProps {
  extractionId: string;
  finalized: boolean;
  correctionCount: number;
}

export function FinalizeButton({
  extractionId,
  finalized: initialFinalized,
  correctionCount,
}: FinalizeButtonProps) {
  const [finalized, setFinalized] = useState(initialFinalized);
  const [loading, setLoading] = useState(false);
  const [saveLoading, setSaveLoading] = useState(false);
  const [saved, setSaved] = useState(false);

  const handleFinalize = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/extractions/${extractionId}/finalize`, {
        method: "POST",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to finalize");
      }
      setFinalized(true);
      toast.success("Extraction finalized");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to finalize");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAsReference = async () => {
    setSaveLoading(true);
    try {
      const res = await fetch(
        `/api/extractions/${extractionId}/save-as-reference`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save reference");
      }
      setSaved(true);
      toast.success("Saved as reference example — future extractions will learn from this");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaveLoading(false);
    }
  };

  if (!finalized) {
    return (
      <Button
        variant="outline"
        onClick={handleFinalize}
        disabled={loading}
        title="Mark this extraction as reviewed — enables saving as a reference example for future learning"
      >
        {loading ? "Finalizing..." : "Finalize"}
      </Button>
    );
  }

  if (saved) {
    return (
      <span className="text-xs text-green-600 font-medium px-2 py-1">
        Saved as reference
      </span>
    );
  }

  return (
    <Button
      variant="default"
      size="sm"
      onClick={handleSaveAsReference}
      disabled={saveLoading}
      className="bg-green-600 hover:bg-green-700"
      title="Save this corrected extraction as a reference example to improve future AI extractions"
    >
      {saveLoading
        ? "Saving..."
        : `Save as Reference${correctionCount > 0 ? ` (${correctionCount} corrections)` : ""}`}
    </Button>
  );
}
