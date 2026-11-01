"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CalibrationDistanceDialog({
  distance,
  onDistanceChange,
  onConfirm,
  onCancel,
}: {
  distance: string;
  onDistanceChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background rounded-lg p-6 shadow-lg max-w-sm w-full mx-4">
        <h3 className="font-semibold mb-2">Set Scale</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Enter the real-world distance between the two points you clicked (in feet).
        </p>
        <Input
          type="number"
          step="any"
          placeholder="e.g., 40"
          value={distance}
          onChange={(e) => onDistanceChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onConfirm()}
          autoFocus
        />
        <div className="flex gap-2 mt-4">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Set Scale</Button>
        </div>
      </div>
    </div>
  );
}
