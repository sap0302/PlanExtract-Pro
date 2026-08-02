"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MeasurementShape } from "./measurement-canvas";
import type { AddToItemsData } from "./measurement-panel";

interface MeasurementFloatingActionsProps {
  measurement: MeasurementShape;
  /** Screen-space anchor point (already transformed by zoom/pan). */
  anchor: { x: number; y: number };
  onLabelChange: (label: string) => void;
  onDelete: () => void;
  onAddToItems: (data: AddToItemsData) => void;
}

/** Small popover anchored to the selected measurement — replaces the old
 * right-hand Measurements panel's rename / delete / Add to Items controls. */
export function MeasurementFloatingActions({
  measurement: m,
  anchor,
  onLabelChange,
  onDelete,
  onAddToItems,
}: MeasurementFloatingActionsProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(m.label || "");
  const [showAddForm, setShowAddForm] = useState(false);
  const isLinked = !!m.itemId;

  const commitEdit = () => {
    onLabelChange(editValue.trim());
    setEditing(false);
  };

  return (
    <div
      className="absolute z-20"
      style={{ left: anchor.x, top: anchor.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1 bg-background border rounded shadow-lg px-1.5 py-1">
        {editing ? (
          <Input
            className="h-6 w-32 text-xs px-1"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setEditing(false);
            }}
            autoFocus
          />
        ) : (
          <button
            className="text-xs font-medium max-w-[140px] truncate hover:underline"
            title="Click to rename"
            onClick={() => {
              setEditValue(m.label || "");
              setEditing(true);
            }}
          >
            {m.label || m.type}
          </button>
        )}
        {!isLinked && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-blue-500"
            onClick={() => setShowAddForm((s) => !s)}
            title="Add to items"
          >
            +
          </Button>
        )}
        {isLinked && (
          <span className="text-green-600 text-[10px] px-1" title="Added to items">
            ✓
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-red-500"
          onClick={onDelete}
          title="Delete (Del)"
        >
          ✕
        </Button>
      </div>

      {showAddForm && (
        <AddToItemsForm
          measurement={m}
          defaultName={m.label || ""}
          onSubmit={(data) => {
            onAddToItems(data);
            setShowAddForm(false);
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}
    </div>
  );
}

function AddToItemsForm({
  measurement,
  defaultName,
  onSubmit,
  onCancel,
}: {
  measurement: MeasurementShape;
  defaultName: string;
  onSubmit: (data: AddToItemsData) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [measurementType, setMeasurementType] = useState<"area" | "count" | "linear">(
    measurement.type as "area" | "count" | "linear"
  );
  const [system, setSystem] = useState<"water" | "storm_drain" | "wastewater" | "other">("water");
  const [quantity, setQuantity] = useState(
    measurement.type === "count"
      ? String(measurement.valueCount ?? 1)
      : String(measurement.valueFt?.toFixed(2) ?? "0")
  );

  const handleSubmit = () => {
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      measurementType,
      system,
      quantity: parseFloat(quantity) || 0,
    });
  };

  return (
    <div className="mt-1 w-56 p-2 border rounded bg-background shadow-lg space-y-2">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">
        Add to Items
      </div>

      <Input
        className="h-7 text-xs"
        placeholder='Item name (e.g., 8" DR18 W)'
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        autoFocus
      />

      <div className="flex gap-1">
        <select
          className="flex-1 h-7 text-xs rounded border bg-background px-1"
          value={measurementType}
          onChange={(e) => setMeasurementType(e.target.value as "area" | "count" | "linear")}
        >
          <option value="linear">Linear (FT)</option>
          <option value="count">Count (EA)</option>
          <option value="area">Area (SQ FT)</option>
        </select>
        <select
          className="flex-1 h-7 text-xs rounded border bg-background px-1"
          value={system}
          onChange={(e) =>
            setSystem(e.target.value as "water" | "storm_drain" | "wastewater" | "other")
          }
        >
          <option value="water">Water</option>
          <option value="storm_drain">Storm Drain</option>
          <option value="wastewater">Wastewater</option>
          <option value="other">Other</option>
        </select>
      </div>

      <div className="flex items-center gap-1">
        <span className="text-[10px] text-muted-foreground w-8">Qty:</span>
        <Input
          className="h-7 text-xs flex-1"
          type="number"
          step="any"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        />
      </div>

      <div className="flex gap-1">
        <Button size="sm" className="h-6 text-xs flex-1" onClick={handleSubmit} disabled={!name.trim()}>
          Add Item
        </Button>
        <Button variant="outline" size="sm" className="h-6 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
