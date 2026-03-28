"use client";

import { useState, useCallback, useEffect } from "react";
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
import { toast } from "sonner";
import type { Item } from "@prisma/client";

/** Isolated numeric input that manages its own local state to prevent focus loss on parent re-renders. */
function EditableNumberCell({
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
      type="number"
      step={step ?? "any"}
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => onChange(parseFloat(local) || 0)}
      className={className ?? "h-7 text-sm w-[80px]"}
    />
  );
}

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

  const deleteItem = useCallback(async (itemId: string) => {
    setDeletingId(itemId);
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: "DELETE",
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

  const itemColumns: ColumnDef<Item>[] = [
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
              >
                ✗
              </Button>
            </div>
          );
        }

        return (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => startEditing(item)}
              className="text-muted-foreground hover:text-foreground px-1.5"
              title="Edit item"
            >
              ✎
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => deleteItem(item.id)}
              disabled={isDeleting}
              className="text-muted-foreground hover:text-red-600 px-1.5"
              title="Delete item"
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
            <Input
              value={editValues.name ?? ""}
              onChange={(e) =>
                setEditValues((prev) => ({ ...prev, name: e.target.value }))
              }
              className="h-7 text-sm min-w-[180px]"
            />
          );
        }
        return (
          <span className="font-medium">
            {item.isDemo && (
              <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold bg-red-100 text-red-700 mr-1.5">
                DEMO
              </span>
            )}
            {item.name}
          </span>
        );
      },
    },
    {
      accessorKey: "sourceSheetId",
      header: "Sheet",
      size: 80,
      cell: ({ row }) => {
        const item = row.original;
        return item.sourceSheetId || "\u2014";
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

        return item.measurementType === "count"
          ? qty.toFixed(0)
          : qty.toFixed(2);
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
            <Input
              value={editValues.description ?? item.description ?? ""}
              onChange={(e) =>
                setEditValues((prev) => ({
                  ...prev,
                  description: e.target.value || null,
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

  const areaItems = localItems.filter((i) => i.measurementType === "area");
  const countItems = localItems.filter((i) => i.measurementType === "count");
  const linearItems = localItems.filter((i) => i.measurementType === "linear");

  return (
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
        <DataTable columns={itemColumns} data={areaItems} getRowId={(row) => (row as Item).id} />
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
        <DataTable columns={itemColumns} data={countItems} getRowId={(row) => (row as Item).id} />
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
        <DataTable columns={itemColumns} data={linearItems} getRowId={(row) => (row as Item).id} />
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
  );
}
