"use client";

import React, { useState, useCallback, useEffect } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable } from "./data-table";
import { ReferenceDiffDialog } from "./reference-diff-dialog";
import { toast } from "sonner";
import type { Item } from "@prisma/client";

/** Isolated text input that manages its own local state to prevent focus loss on parent re-renders. */
const EditableTextCell = React.memo(function EditableTextCell({
  value,
  onChange,
  className,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  return (
    <Input
      type="text"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => onChange(local)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onChange(local);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={className}
      placeholder={placeholder}
    />
  );
});

/** Isolated numeric input that manages its own local state to prevent focus loss on parent re-renders. */
const EditableNumberCell = React.memo(function EditableNumberCell({
  value,
  onChange,
  step,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: string;
  className?: string;
}) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => {
    setLocal(String(value));
  }, [value]);
  return (
    <Input
      type="text"
      inputMode="decimal"
      value={local}
      onChange={(e) => {
        const v = e.target.value;
        // Allow digits, decimal point, and empty string (for clearing)
        if (v === "" || /^-?\d*\.?\d*$/.test(v)) {
          setLocal(v);
        }
      }}
      onBlur={() => onChange(parseFloat(local) || 0)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          onChange(parseFloat(local) || 0);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={className ?? "h-7 text-sm w-[80px]"}
    />
  );
});

const systemLabels: Record<string, string> = {
  water: "Water",
  storm_drain: "Storm Drain",
  wastewater: "Wastewater",
  other: "Other",
};

const systemColors: Record<string, string> = {
  water: "bg-blue-100 text-blue-800",
  storm_drain: "bg-green-100 text-green-800",
  wastewater: "bg-amber-100 text-amber-800",
  other: "bg-gray-100 text-gray-800",
};

const confidenceColors: Record<string, string> = {
  high: "bg-green-100 text-green-800",
  medium: "bg-yellow-100 text-yellow-800",
  low: "bg-red-100 text-red-800",
};

const confidenceLabels: Record<string, string> = {
  high: "High",
  medium: "Med",
  low: "Low",
};

const methodLabels: Record<string, string> = {
  station_math: "Station",
  callout: "Callout",
  schedule: "Schedule",
  count: "Count",
  scale_estimate: "Scale Est.",
};

/**
 * Magic suffix used by the AI extractor to mark items that require manual
 * measurement (Tier 3). Must match MANUAL_MEASURE_SUFFIX in chunked.ts.
 * Rows with this suffix get a yellow background, sort to the top, and show
 * a "Measure" button that opens the measurement tool pre-focused on them.
 */
const MANUAL_MEASURE_SUFFIX = " - MEASURE MANUALLY";

/**
 * Returns true if an item is a Tier 3 placeholder row needing human measurement.
 * Checks both the magic name suffix AND that quantity is zero — once a human
 * measures the item, the quantity goes above zero and the row becomes "normal".
 */
const isManualRequired = (item: Item): boolean =>
  item.name.endsWith(MANUAL_MEASURE_SUFFIX) && item.quantity === 0;

type EditValues = Partial<
  Pick<
    Item,
    | "name"
    | "quantity"
    | "system"
    | "unit"
    | "description"
    | "confidence"
    | "costEach"
    | "markupPercent"
  >
>;

interface InventoryTabsProps {
  items: Item[];
  extractionId: string;
}

export function InventoryTabs({ items, extractionId }: InventoryTabsProps) {
  const [localItems, setLocalItems] = useState<Item[]>(items);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<EditValues>({});
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confidenceFilter, setConfidenceFilter] = useState<
    "all" | "high" | "medium" | "low" | "manual"
  >("all");
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);

  const startEditing = useCallback((item: Item) => {
    setEditingId(item.id);
    setEditValues({
      name: item.name,
      quantity: item.quantity,
      system: item.system,
      unit: item.unit,
      description: item.description,
      confidence: item.confidence,
      costEach: item.costEach,
      markupPercent: item.markupPercent,
    });
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingId(null);
    setEditValues({});
  }, []);

  const saveEdit = useCallback(
    async (itemId: string) => {
      setSaving(true);
      try {
        const res = await fetch(`/api/items/${itemId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(editValues),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to update item");
        }

        const updated = await res.json();

        // Update local state optimistically
        setLocalItems((prev) =>
          prev.map((item) => (item.id === itemId ? { ...item, ...updated } : item))
        );

        setEditingId(null);
        setEditValues({});
        toast.success("Item updated");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to update item"
        );
      } finally {
        setSaving(false);
      }
    },
    [editValues]
  );

  const addItem = useCallback(
    async (measurementType: "area" | "count" | "linear") => {
      setAdding(true);
      try {
        const res = await fetch("/api/items", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ extractionId, measurementType }),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to add item");
        }

        const newItem: Item = await res.json();

        // Add to local state and auto-enter edit mode
        setLocalItems((prev) => [...prev, newItem]);
        startEditing(newItem);
        toast.success("Row added — fill in the details");
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to add item"
        );
      } finally {
        setAdding(false);
      }
    },
    [extractionId, startEditing]
  );

  // Delete reason dialog state (for AI-extracted items)
  const [deleteDialogItem, setDeleteDialogItem] = useState<{ id: string; name: string } | null>(null);

  const deleteItem = useCallback(async (itemId: string, reason?: "not_on_plans" | "not_in_scope") => {
    setDeletingId(itemId);
    setDeleteDialogItem(null);
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to delete item");
      }

      // Remove from local state
      setLocalItems((prev) => prev.filter((item) => item.id !== itemId));

      // Clear editing state if we deleted the item being edited
      setEditingId((prev) => (prev === itemId ? null : prev));

      toast.success("Item deleted");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete item"
      );
    } finally {
      setDeletingId(null);
    }
  }, []);

  // Handle delete button click — show reason dialog for AI items, instant for user items
  const handleDeleteClick = useCallback((item: Item) => {
    if (item.originalAiQuantity != null) {
      // AI-extracted item — ask why
      setDeleteDialogItem({ id: item.id, name: item.name });
    } else {
      // User-added item — instant delete
      deleteItem(item.id);
    }
  }, [deleteItem]);

  /**
   * Re-verify a single item by calling the focused verification endpoint.
   * The server re-reads the drawing just for this item and returns either
   * a quantity correction, a name correction, or no change. Updates the
   * row in-place on success.
   */
  const verifyItem = useCallback(
    async (itemId: string) => {
      setVerifyingId(itemId);
      try {
        const res = await fetch(
          `/api/extractions/${extractionId}/verify-item`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ itemId }),
          }
        );
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Verification failed");
        }
        const result = await res.json();
        const updated: Item | null = result.item;
        if (updated) {
          setLocalItems((prev) =>
            prev.map((it) => (it.id === itemId ? updated : it))
          );
        }
        if (result.changed) {
          const parts: string[] = [];
          if (result.quantityChanged) {
            parts.push(
              `qty ${Number(result.previousQuantity).toFixed(2)} → ${Number(
                updated?.quantity ?? 0
              ).toFixed(2)}`
            );
          }
          if (result.nameChanged) {
            parts.push(`name: "${result.previousName}" → "${updated?.name}"`);
          }
          toast.success(`Item re-verified (${parts.join(", ")})`);
        } else {
          toast.success("Item re-verified — no changes needed");
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Verification failed"
        );
      } finally {
        setVerifyingId(null);
      }
    },
    [extractionId]
  );

  const itemColumns: ColumnDef<Item>[] = [
    {
      id: "select",
      header: "",
      size: 32,
      cell: ({ row }) => {
        const item = row.original;
        return (
          <input
            type="checkbox"
            checked={selectedIds.has(item.id)}
            onChange={() => toggleSelect(item.id)}
            className="h-3.5 w-3.5 rounded border-gray-300 cursor-pointer"
          />
        );
      },
    },
    {
      id: "actions",
      header: "",
      size: 110,
      cell: ({ row }) => {
        const item = row.original;
        const isEditing = editingId === item.id;
        const isDeleting = deletingId === item.id;

        if (isEditing) {
          return (
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => saveEdit(item.id)}
                disabled={saving}
                className="text-green-600 hover:text-green-700 px-1.5"
                title="Save"
                aria-label="Save changes"
              >
                ✓
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={cancelEditing}
                disabled={saving}
                className="text-red-600 hover:text-red-700 px-1.5"
                title="Cancel"
                aria-label="Cancel editing"
              >
                ✗
              </Button>
            </div>
          );
        }

        const isVerifying = verifyingId === item.id;
        const isManual = isManualRequired(item);
        return (
          <div className="flex gap-1">
            {isManual && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  window.open(
                    `/extractions/${extractionId}/measure?item=${item.id}`,
                    "_blank"
                  )
                }
                className="text-yellow-700 hover:text-yellow-900 hover:bg-yellow-100 px-1.5 font-semibold"
                title="Open measurement tool and measure this item"
                aria-label="Measure this item"
              >
                📐
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => startEditing(item)}
              className="text-muted-foreground hover:text-foreground px-1.5"
              title="Edit item"
              aria-label="Edit item"
            >
              ✎
            </Button>
            {!isManual && (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => verifyItem(item.id)}
                disabled={isVerifying || verifyingId !== null}
                className="text-muted-foreground hover:text-blue-600 px-1.5 disabled:opacity-40"
                title="Re-verify this item against the plans (uses an extra AI call)"
                aria-label="Re-verify item"
              >
                {isVerifying ? "…" : "↻"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => handleDeleteClick(item)}
              disabled={isDeleting}
              className="text-muted-foreground hover:text-red-600 px-1.5"
              title="Delete item"
              aria-label="Delete item"
            >
              🗑
            </Button>
          </div>
        );
      },
    },
    {
      accessorKey: "name",
      header: "Item Name",
      cell: ({ row }) => {
        const item = row.original;
        if (editingId === item.id) {
          return (
            <EditableTextCell
              value={editValues.name ?? item.name}
              onChange={(v) =>
                setEditValues((prev) => ({ ...prev, name: v }))
              }
              className="h-7 text-sm min-w-[180px]"
            />
          );
        }
        const isManual = isManualRequired(item);
        // Strip the magic suffix from the display — the yellow MEASURE badge
        // tells the user everything they need to know about the status.
        const displayName = isManual
          ? item.name.slice(0, -MANUAL_MEASURE_SUFFIX.length)
          : item.name;
        return (
          <span className="font-medium">
            {isManual && (
              <span
                className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-yellow-100 text-yellow-800 mr-1.5"
                title="This item needs manual measurement — click the 📐 button to open the measurement tool"
              >
                📐 MEASURE
              </span>
            )}
            {item.isDemo && (
              <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-red-100 text-red-700 mr-1.5">
                DEMO
              </span>
            )}
            {displayName}
          </span>
        );
      },
    },
    {
      accessorKey: "sourceSheetId",
      header: "Sheet / Page",
      size: 110,
      cell: ({ row }) => {
        const item = row.original;
        const sheet = item.sourceSheetId || "";
        const pages = item.sourcePages
          ? (() => {
              try {
                const arr = JSON.parse(item.sourcePages);
                return Array.isArray(arr) ? arr.join(", ") : "";
              } catch { return ""; }
            })()
          : "";
        if (!sheet && !pages) return "\u2014";
        if (sheet && pages) return <span>{sheet} <span className="text-muted-foreground">(p{pages})</span></span>;
        return sheet || `p${pages}`;
      },
    },
    {
      accessorKey: "quantityMethod",
      header: "Method",
      size: 90,
      cell: ({ row }) => {
        const item = row.original;
        const method = item.quantityMethod;
        if (!method) return "\u2014";
        return (
          <span className="text-xs text-muted-foreground">
            {methodLabels[method] || method}
          </span>
        );
      },
    },
    {
      accessorKey: "confidence",
      header: "Conf.",
      size: 70,
      cell: ({ row }) => {
        const item = row.original;
        const confidence = item.confidence || "medium";

        if (editingId === item.id) {
          return (
            <Select
              value={editValues.confidence || "medium"}
              onValueChange={(val) =>
                setEditValues((prev) => ({ ...prev, confidence: val }))
              }
            >
              <SelectTrigger className="h-7 text-xs w-[80px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Med</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
          );
        }

        return (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
              confidenceColors[confidence] || "bg-gray-100 text-gray-800"
            }`}
          >
            {confidenceLabels[confidence] || confidence}
          </span>
        );
      },
    },
    {
      accessorKey: "system",
      header: "System",
      cell: ({ row }) => {
        const item = row.original;
        const system = item.system;

        if (editingId === item.id) {
          return (
            <Select
              value={editValues.system || system}
              onValueChange={(val) =>
                setEditValues((prev) => ({ ...prev, system: val }))
              }
            >
              <SelectTrigger className="h-7 text-xs w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="water">Water</SelectItem>
                <SelectItem value="storm_drain">Storm Drain</SelectItem>
                <SelectItem value="wastewater">Wastewater</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          );
        }

        return (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
              systemColors[system] || "bg-gray-100 text-gray-800"
            }`}
          >
            {systemLabels[system] || system}
          </span>
        );
      },
    },
    {
      accessorKey: "quantity",
      header: "Qty",
      cell: ({ row }) => {
        const item = row.original;
        const qty = item.quantity;

        if (editingId === item.id) {
          return (
            <EditableNumberCell
              value={editValues.quantity ?? qty}
              onChange={(v) =>
                setEditValues((prev) => ({ ...prev, quantity: v }))
              }
            />
          );
        }

        const aiQty = item.originalAiQuantity;
        const formatted = item.measurementType === "count"
          ? qty.toFixed(0)
          : qty.toFixed(2);

        // Show delta if user corrected the AI's quantity
        if (aiQty != null && Math.abs(aiQty - qty) > 0.01) {
          const aiFormatted = item.measurementType === "count"
            ? aiQty.toFixed(0)
            : aiQty.toFixed(2);
          return (
            <span>
              {formatted}
              <span className="ml-1 text-[10px] text-muted-foreground" title={`AI extracted: ${aiFormatted}`}>
                (AI: {aiFormatted})
              </span>
            </span>
          );
        }
        return formatted;
      },
    },
    {
      accessorKey: "unit",
      header: "Unit",
      cell: ({ row }) => {
        const item = row.original;

        if (editingId === item.id) {
          return (
            <Select
              value={editValues.unit || item.unit}
              onValueChange={(val) =>
                setEditValues((prev) => ({ ...prev, unit: val }))
              }
            >
              <SelectTrigger className="h-7 text-xs w-[80px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SQ FT">SQ FT</SelectItem>
                <SelectItem value="EA">EA</SelectItem>
                <SelectItem value="FT">FT</SelectItem>
              </SelectContent>
            </Select>
          );
        }

        return item.unit;
      },
    },
    {
      accessorKey: "costEach",
      header: "Cost Each",
      cell: ({ row }) => {
        const item = row.original;

        if (editingId === item.id) {
          return (
            <EditableNumberCell
              value={editValues.costEach ?? item.costEach}
              onChange={(v) =>
                setEditValues((prev) => ({ ...prev, costEach: v }))
              }
              step="0.01"
              className="h-7 text-sm w-[90px]"
            />
          );
        }

        return `$${item.costEach.toFixed(2)}`;
      },
    },
    {
      accessorKey: "markupPercent",
      header: "Markup %",
      cell: ({ row }) => {
        const item = row.original;

        if (editingId === item.id) {
          return (
            <EditableNumberCell
              value={editValues.markupPercent ?? item.markupPercent}
              onChange={(v) =>
                setEditValues((prev) => ({ ...prev, markupPercent: v }))
              }
              step="0.1"
            />
          );
        }

        return `${item.markupPercent.toFixed(1)}%`;
      },
    },
    {
      accessorKey: "priceEach",
      header: "Price Each",
      cell: ({ row }) => `$${(row.getValue("priceEach") as number).toFixed(2)}`,
    },
    {
      accessorKey: "priceTotal",
      header: "Price Total",
      cell: ({ row }) =>
        `$${(row.getValue("priceTotal") as number).toFixed(2)}`,
    },
    {
      accessorKey: "description",
      header: "Notes",
      cell: ({ row }) => {
        const item = row.original;

        if (editingId === item.id) {
          return (
            <EditableTextCell
              value={editValues.description ?? item.description ?? ""}
              onChange={(v) =>
                setEditValues((prev) => ({
                  ...prev,
                  description: v || null,
                }))
              }
              placeholder="Notes..."
              className="h-7 text-sm min-w-[150px]"
            />
          );
        }

        return item.description || "\u2014";
      },
    },
  ];

  // Bulk confidence update
  const bulkUpdateConfidence = useCallback(
    async (confidence: string) => {
      if (selectedIds.size === 0) return;
      const ids = Array.from(selectedIds);
      try {
        await Promise.all(
          ids.map((id) =>
            fetch(`/api/items/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ confidence }),
            })
          )
        );
        setLocalItems((prev) =>
          prev.map((item) =>
            selectedIds.has(item.id) ? { ...item, confidence } : item
          )
        );
        toast.success(`Updated ${ids.length} items to ${confidence} confidence`);
        setSelectedIds(new Set());
      } catch {
        toast.error("Failed to update some items");
      }
    },
    [selectedIds]
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((items: Item[]) => {
    setSelectedIds((prev) => {
      const allSelected = items.every((i) => prev.has(i.id));
      const next = new Set(prev);
      if (allSelected) {
        items.forEach((i) => next.delete(i.id));
      } else {
        items.forEach((i) => next.add(i.id));
      }
      return next;
    });
  }, []);

  // Filter items by search query + confidence filter
  const query = searchQuery.toLowerCase().trim();
  const filtered = localItems.filter((i) => {
    if (query) {
      const matchesQuery =
        i.name.toLowerCase().includes(query) ||
        (i.sourceSheetId || "").toLowerCase().includes(query) ||
        (i.system || "").toLowerCase().includes(query) ||
        (i.description || "").toLowerCase().includes(query);
      if (!matchesQuery) return false;
    }
    if (confidenceFilter === "manual") {
      if (!isManualRequired(i)) return false;
    } else if (confidenceFilter !== "all" && i.confidence !== confidenceFilter) {
      return false;
    }
    return true;
  });

  // Sort so Tier 3 placeholder rows (manual measurement required) appear
  // at the top of each tab. The reviewer works through these first.
  const sortPlaceholdersFirst = (a: Item, b: Item): number => {
    const aManual = isManualRequired(a) ? 0 : 1;
    const bManual = isManualRequired(b) ? 0 : 1;
    if (aManual !== bManual) return aManual - bManual;
    return a.name.localeCompare(b.name);
  };

  const areaItems = filtered
    .filter((i) => i.measurementType === "area")
    .sort(sortPlaceholdersFirst);
  const countItems = filtered
    .filter((i) => i.measurementType === "count")
    .sort(sortPlaceholdersFirst);
  const linearItems = filtered
    .filter((i) => i.measurementType === "linear")
    .sort(sortPlaceholdersFirst);

  return (
    <div className="space-y-3">
      {/* Search bar + filters + bulk actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Input
          type="text"
          placeholder="Search items by name, sheet, system..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-8 text-sm max-w-xs"
        />
        <Select
          value={confidenceFilter}
          onValueChange={(v) =>
            setConfidenceFilter(
              v as "all" | "high" | "medium" | "low" | "manual"
            )
          }
        >
          <SelectTrigger className="h-8 text-xs w-[180px]" aria-label="Filter by confidence">
            <SelectValue placeholder="All confidence" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All confidence</SelectItem>
            <SelectItem value="manual">📐 Needs manual measurement</SelectItem>
            <SelectItem value="low">Low confidence only</SelectItem>
            <SelectItem value="medium">Medium confidence only</SelectItem>
            <SelectItem value="high">High confidence only</SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={() => setCompareDialogOpen(true)}
          title="Upload a PlanSwift takeoff CSV to diff against this extraction"
        >
          Compare to reference
        </Button>
        {selectedIds.size > 0 && (
          <div className="flex items-center gap-1 text-sm">
            <span className="text-muted-foreground">{selectedIds.size} selected:</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkUpdateConfidence("high")}>
              Set High
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkUpdateConfidence("medium")}>
              Set Med
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => bulkUpdateConfidence("low")}>
              Set Low
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
          </div>
        )}
      </div>

    <Tabs defaultValue="count" className="w-full">
      <TabsList className="w-full justify-start overflow-x-auto">
        <TabsTrigger value="area" className="gap-2">
          Area
          <Badge variant="secondary" className="ml-1">
            {areaItems.length}
          </Badge>
        </TabsTrigger>
        <TabsTrigger value="count" className="gap-2">
          Count
          <Badge variant="secondary" className="ml-1">
            {countItems.length}
          </Badge>
        </TabsTrigger>
        <TabsTrigger value="linear" className="gap-2">
          Linear
          <Badge variant="secondary" className="ml-1">
            {linearItems.length}
          </Badge>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="area" className="mt-4">
        <DataTable
          columns={itemColumns}
          data={areaItems}
          getRowId={(row) => (row as Item).id}
          getRowClassName={(row) =>
            isManualRequired(row as Item)
              ? "bg-yellow-50 hover:bg-yellow-100"
              : undefined
          }
        />
        <div className="mt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => addItem("area")}
            disabled={adding}
            className="gap-1"
          >
            + Add Row
          </Button>
        </div>
      </TabsContent>
      <TabsContent value="count" className="mt-4">
        <DataTable
          columns={itemColumns}
          data={countItems}
          getRowId={(row) => (row as Item).id}
          getRowClassName={(row) =>
            isManualRequired(row as Item)
              ? "bg-yellow-50 hover:bg-yellow-100"
              : undefined
          }
        />
        <div className="mt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => addItem("count")}
            disabled={adding}
            className="gap-1"
          >
            + Add Row
          </Button>
        </div>
      </TabsContent>
      <TabsContent value="linear" className="mt-4">
        <DataTable
          columns={itemColumns}
          data={linearItems}
          getRowId={(row) => (row as Item).id}
          getRowClassName={(row) =>
            isManualRequired(row as Item)
              ? "bg-yellow-50 hover:bg-yellow-100"
              : undefined
          }
        />
        <div className="mt-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => addItem("linear")}
            disabled={adding}
            className="gap-1"
          >
            + Add Row
          </Button>
        </div>
      </TabsContent>
    </Tabs>

    {/* Reference comparison dialog — uploads a PlanSwift CSV and shows diff */}
    <ReferenceDiffDialog
      extractionId={extractionId}
      open={compareDialogOpen}
      onOpenChange={setCompareDialogOpen}
    />

    {/* Delete reason dialog — shown for AI-extracted items */}
    {deleteDialogItem && (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-background rounded-lg p-5 shadow-lg max-w-sm w-full mx-4">
          <h3 className="font-semibold text-sm mb-1">Remove item</h3>
          <p className="text-xs text-muted-foreground mb-3">
            <span className="font-medium text-foreground">{deleteDialogItem.name}</span>
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            Why are you removing this? This helps the AI learn.
          </p>
          <div className="flex flex-col gap-2">
            <button
              className="w-full px-3 py-2 rounded text-sm font-medium bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 transition-colors"
              onClick={() => deleteItem(deleteDialogItem.id, "not_on_plans")}
            >
              Not on plans — AI was wrong
            </button>
            <button
              className="w-full px-3 py-2 rounded text-sm font-medium bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200 transition-colors"
              onClick={() => deleteItem(deleteDialogItem.id, "not_in_scope")}
            >
              Not in scope — item exists but not needed
            </button>
            <button
              className="w-full px-3 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setDeleteDialogItem(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )}
    </div>
  );
}
