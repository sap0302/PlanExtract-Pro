"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMeasurement } from "@/lib/measurement-utils";
import type { MeasurementShape } from "./measurement-canvas";

export interface AddToItemsData {
  name: string;
  measurementType: "area" | "count" | "linear";
  system: "water" | "storm_drain" | "wastewater" | "other";
  quantity: number;
}

interface MeasurementPanelProps {
  measurements: MeasurementShape[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => void;
  onLabelChange: (id: string, label: string) => void;
  onAddToItems: (measurementId: string, data: AddToItemsData) => void;
  onPageJump: (page: number) => void;
  currentPage: number;
  scaleDescription?: string;
}

const typeIcons: Record<string, string> = {
  linear: "\u{1F4CF}",
  area: "\u2B1C",
  count: "\u{1F4CD}",
};

export function MeasurementPanel({
  measurements,
  selectedId,
  onSelect,
  onDelete,
  onLabelChange,
  onAddToItems,
  onPageJump,
  currentPage,
  scaleDescription,
}: MeasurementPanelProps) {
  const pageMeasurements = measurements.filter((m) => m.page === currentPage);
  const otherMeasurements = measurements.filter((m) => m.page !== currentPage);

  const totalLinear = measurements
    .filter((m) => m.type === "linear" && m.valueFt)
    .reduce((sum, m) => sum + (m.valueFt ?? 0), 0);
  const totalArea = measurements
    .filter((m) => m.type === "area" && m.valueFt)
    .reduce((sum, m) => sum + (m.valueFt ?? 0), 0);
  const totalCount = measurements.filter((m) => m.type === "count").length;

  return (
    <div className="flex flex-col h-full border-l bg-background">
      {/* Header */}
      <div className="px-3 py-2 border-b">
        <h3 className="font-semibold text-sm">Measurements</h3>
        {scaleDescription && (
          <p className="text-xs text-muted-foreground mt-0.5">{scaleDescription}</p>
        )}
      </div>

      {/* Summary */}
      <div className="px-3 py-2 border-b bg-muted/30 text-xs space-y-0.5">
        {totalLinear > 0 && (
          <div className="flex justify-between">
            <span>{typeIcons.linear} Linear</span>
            <span className="font-mono font-medium">{totalLinear.toFixed(1)} FT</span>
          </div>
        )}
        {totalArea > 0 && (
          <div className="flex justify-between">
            <span>{typeIcons.area} Area</span>
            <span className="font-mono font-medium">{totalArea.toFixed(1)} SQ FT</span>
          </div>
        )}
        {totalCount > 0 && (
          <div className="flex justify-between">
            <span>{typeIcons.count} Count</span>
            <span className="font-mono font-medium">{totalCount} EA</span>
          </div>
        )}
        {measurements.length === 0 && (
          <div className="text-muted-foreground italic">No measurements yet</div>
        )}
      </div>

      {/* Measurement list */}
      <div className="flex-1 overflow-y-auto">
        {pageMeasurements.length > 0 && (
          <div className="px-2 pt-2">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-1">
              Page {currentPage}
            </div>
            {pageMeasurements.map((m, idx) => (
              <MeasurementRow
                key={m.id}
                measurement={m}
                index={idx + 1}
                isSelected={m.id === selectedId}
                onSelect={() => onSelect(m.id === selectedId ? null : m.id)}
                onDelete={() => onDelete(m.id)}
                onLabelChange={(label) => onLabelChange(m.id, label)}
                onAddToItems={(data) => onAddToItems(m.id, data)}
              />
            ))}
          </div>
        )}

        {otherMeasurements.length > 0 && (
          <div className="px-2 pt-2">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1 px-1">
              Other pages
            </div>
            {otherMeasurements.map((m, idx) => (
              <MeasurementRow
                key={m.id}
                measurement={m}
                index={idx + 1}
                isSelected={m.id === selectedId}
                onSelect={() => {
                  onPageJump(m.page);
                  onSelect(m.id);
                }}
                onDelete={() => onDelete(m.id)}
                onLabelChange={(label) => onLabelChange(m.id, label)}
                onAddToItems={(data) => onAddToItems(m.id, data)}
                showPage
              />
            ))}
          </div>
        )}
      </div>

      {/* Keyboard hints */}
      <div className="px-3 py-2 border-t text-[10px] text-muted-foreground space-y-0.5">
        <div>Del — delete selected</div>
        <div>Ctrl+Z — undo</div>
        <div>Space — hold to pan</div>
      </div>
    </div>
  );
}

function MeasurementRow({
  measurement: m,
  index,
  isSelected,
  onSelect,
  onDelete,
  onLabelChange,
  onAddToItems,
  showPage,
}: {
  measurement: MeasurementShape;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onLabelChange: (label: string) => void;
  onAddToItems: (data: AddToItemsData) => void;
  showPage?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

  const defaultLabel = `${m.type.charAt(0).toUpperCase() + m.type.slice(1)} ${index}`;
  const displayLabel = m.label || defaultLabel;

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(m.label || "");
    setEditing(true);
  };

  const commitEdit = () => {
    const trimmed = editValue.trim();
    onLabelChange(trimmed);
    setEditing(false);
  };

  const isLinked = !!m.itemId;

  return (
    <>
      <div
        className={`flex items-center gap-1.5 px-2 py-1.5 rounded text-sm cursor-pointer hover:bg-muted/50 group ${
          isSelected ? "bg-muted ring-1 ring-primary" : ""
        }`}
        onClick={onSelect}
      >
        <span className="text-sm shrink-0" style={{ color: m.color }}>
          {typeIcons[m.type] || "?"}
        </span>
        <div className="flex-1 min-w-0">
          {editing ? (
            <Input
              className="h-5 text-xs px-1"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") setEditing(false);
              }}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <div
              className="truncate text-xs font-medium hover:underline cursor-text"
              onDoubleClick={startEditing}
              title="Double-click to rename"
            >
              {displayLabel}
              {showPage && (
                <span className="text-muted-foreground ml-1">(p{m.page})</span>
              )}
              {isLinked && (
                <span className="text-green-600 ml-1 text-[10px]" title="Added to items">
                  ✓
                </span>
              )}
            </div>
          )}
          <div className="text-xs text-muted-foreground font-mono">
            {formatMeasurement(m.type, m.valueFt ?? null, m.valueCount ?? null)}
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {!isLinked && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0 text-muted-foreground hover:text-blue-500"
              onClick={(e) => {
                e.stopPropagation();
                setShowAddForm(!showAddForm);
              }}
              title="Add to items"
            >
              +
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0 text-muted-foreground hover:text-red-500"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete (Del)"
          >
            ✕
          </Button>
        </div>
      </div>

      {/* Add to Items inline form */}
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
    </>
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
    <div
      className="mx-2 mb-2 p-2 border rounded bg-muted/20 space-y-2"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">
        Add to Items
      </div>

      {/* Name */}
      <Input
        className="h-7 text-xs"
        placeholder='Item name (e.g., 8" DR18 W)'
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        autoFocus
      />

      {/* Type + System row */}
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

      {/* Quantity */}
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

      {/* Actions */}
      <div className="flex gap-1">
        <Button
          size="sm"
          className="h-6 text-xs flex-1"
          onClick={handleSubmit}
          disabled={!name.trim()}
        >
          Add Item
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-xs"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
