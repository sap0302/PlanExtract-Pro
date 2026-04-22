"use client";

import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface DiffRow {
  status: "exact" | "close" | "missing" | "extra" | "quantity-mismatch";
  reference: {
    name: string;
    description: string;
    quantity: number;
    unit: string;
    measurementType: "area" | "count" | "linear";
  } | null;
  extraction: {
    id: string;
    name: string;
    quantity: number;
    unit: string;
    measurementType: string;
    confidence: string;
  } | null;
  pctDelta: number | null;
}

interface DiffSummary {
  exact: number;
  close: number;
  quantityMismatch: number;
  missing: number;
  extra: number;
  totalReference: number;
  totalExtraction: number;
  matchRate: number;
}

interface DiffResult {
  extractionName: string;
  referenceItemCount: number;
  rows: DiffRow[];
  summary: DiffSummary;
}

interface ReferenceDiffDialogProps {
  extractionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const statusLabels: Record<DiffRow["status"], string> = {
  exact: "Exact",
  close: "Close",
  "quantity-mismatch": "Qty mismatch",
  missing: "Missing",
  extra: "Extra",
};

const statusColors: Record<DiffRow["status"], string> = {
  exact: "bg-green-100 text-green-800",
  close: "bg-lime-100 text-lime-800",
  "quantity-mismatch": "bg-yellow-100 text-yellow-800",
  missing: "bg-red-100 text-red-800",
  extra: "bg-orange-100 text-orange-800",
};

const statusSortOrder: Record<DiffRow["status"], number> = {
  missing: 0,
  "quantity-mismatch": 1,
  close: 2,
  extra: 3,
  exact: 4,
};

export function ReferenceDiffDialog({
  extractionId,
  open,
  onOpenChange,
}: ReferenceDiffDialogProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [filter, setFilter] = useState<"all" | DiffRow["status"]>("all");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileUpload(file: File) {
    setLoading(true);
    setResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(
        `/api/extractions/${extractionId}/compare`,
        {
          method: "POST",
          body: formData,
        }
      );
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Comparison failed");
      }
      const data = await res.json();
      setResult(data);
      toast.success(
        `Compared against ${data.referenceItemCount} reference items`
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Comparison failed"
      );
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setResult(null);
    setFilter("all");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Sort + filter rows for display
  const rows = result
    ? [...result.rows]
        .sort((a, b) => statusSortOrder[a.status] - statusSortOrder[b.status])
        .filter((r) => filter === "all" || r.status === filter)
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Compare to reference takeoff</DialogTitle>
          <DialogDescription>
            Upload a PlanSwift CSV export (or equivalent) to see how this
            extraction compares. Supports comma-separated, tab-separated, and
            text-dump formats with &quot;Type: Area/Count/Linear&quot; section headers.
          </DialogDescription>
        </DialogHeader>

        {/* Upload area */}
        {!result && (
          <div className="border border-dashed rounded-md p-8 text-center">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file);
              }}
            />
            <div className="text-sm text-muted-foreground mb-3">
              {loading
                ? "Parsing and comparing..."
                : "Drop a .csv or .txt file, or click to browse"}
            </div>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
            >
              {loading ? "Comparing..." : "Choose file"}
            </Button>
          </div>
        )}

        {/* Summary + table */}
        {result && (
          <>
            {/* Summary scorecard */}
            <div className="grid grid-cols-6 gap-2 text-center text-xs">
              <ScoreCard
                label="Exact"
                value={result.summary.exact}
                color="bg-green-50 text-green-800 border-green-200"
              />
              <ScoreCard
                label="Close"
                value={result.summary.close}
                color="bg-lime-50 text-lime-800 border-lime-200"
              />
              <ScoreCard
                label="Qty wrong"
                value={result.summary.quantityMismatch}
                color="bg-yellow-50 text-yellow-800 border-yellow-200"
              />
              <ScoreCard
                label="Missing"
                value={result.summary.missing}
                color="bg-red-50 text-red-800 border-red-200"
              />
              <ScoreCard
                label="Extra"
                value={result.summary.extra}
                color="bg-orange-50 text-orange-800 border-orange-200"
              />
              <ScoreCard
                label="Match rate"
                value={`${(result.summary.matchRate * 100).toFixed(0)}%`}
                color="bg-blue-50 text-blue-800 border-blue-200"
              />
            </div>

            {/* Filter dropdown */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted-foreground">
                {result.summary.totalReference} reference items,{" "}
                {result.summary.totalExtraction} extraction items
              </span>
              <div className="flex gap-1 flex-wrap">
                <FilterButton
                  label="All"
                  active={filter === "all"}
                  onClick={() => setFilter("all")}
                />
                <FilterButton
                  label={`Missing (${result.summary.missing})`}
                  active={filter === "missing"}
                  onClick={() => setFilter("missing")}
                />
                <FilterButton
                  label={`Qty wrong (${result.summary.quantityMismatch})`}
                  active={filter === "quantity-mismatch"}
                  onClick={() => setFilter("quantity-mismatch")}
                />
                <FilterButton
                  label={`Close (${result.summary.close})`}
                  active={filter === "close"}
                  onClick={() => setFilter("close")}
                />
                <FilterButton
                  label={`Extra (${result.summary.extra})`}
                  active={filter === "extra"}
                  onClick={() => setFilter("extra")}
                />
                <FilterButton
                  label={`Exact (${result.summary.exact})`}
                  active={filter === "exact"}
                  onClick={() => setFilter("exact")}
                />
              </div>
              <div className="ml-auto">
                <Button size="sm" variant="ghost" onClick={handleReset}>
                  Upload different file
                </Button>
              </div>
            </div>

            {/* Diff table */}
            <div className="flex-1 overflow-auto border rounded-md">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr className="text-left">
                    <th className="px-2 py-1.5 font-semibold">Status</th>
                    <th className="px-2 py-1.5 font-semibold">Type</th>
                    <th className="px-2 py-1.5 font-semibold">Reference name</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Ref qty</th>
                    <th className="px-2 py-1.5 font-semibold">Extraction name</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Ext qty</th>
                    <th className="px-2 py-1.5 font-semibold text-right">Δ %</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={i} className="border-t hover:bg-muted/50">
                      <td className="px-2 py-1">
                        <Badge
                          variant="outline"
                          className={`${statusColors[row.status]} text-[10px]`}
                        >
                          {statusLabels[row.status]}
                        </Badge>
                      </td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {row.reference?.measurementType ??
                          row.extraction?.measurementType ??
                          ""}
                      </td>
                      <td className="px-2 py-1 font-medium">
                        {row.reference?.name ?? (
                          <span className="text-muted-foreground italic">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {row.reference
                          ? formatQty(
                              row.reference.quantity,
                              row.reference.measurementType
                            )
                          : ""}
                      </td>
                      <td className="px-2 py-1">
                        {row.extraction?.name ?? (
                          <span className="text-muted-foreground italic">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {row.extraction
                          ? formatQty(
                              row.extraction.quantity,
                              row.extraction.measurementType as
                                | "area"
                                | "count"
                                | "linear"
                            )
                          : ""}
                      </td>
                      <td
                        className={`px-2 py-1 text-right font-mono ${
                          row.pctDelta !== null && Math.abs(row.pctDelta) > 25
                            ? "text-red-700 font-semibold"
                            : row.pctDelta !== null &&
                                Math.abs(row.pctDelta) > 5
                              ? "text-yellow-700"
                              : "text-muted-foreground"
                        }`}
                      >
                        {row.pctDelta !== null
                          ? `${row.pctDelta > 0 ? "+" : ""}${row.pctDelta.toFixed(0)}%`
                          : ""}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-2 py-4 text-center text-muted-foreground italic"
                      >
                        No rows match this filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ScoreCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className={`border rounded-md py-2 px-1 ${color}`}>
      <div className="text-lg font-bold font-mono">{value}</div>
      <div className="text-[10px] uppercase tracking-wide">{label}</div>
    </div>
  );
}

function FilterButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[11px] px-2 py-1 rounded border ${
        active
          ? "bg-primary text-primary-foreground border-primary"
          : "bg-background hover:bg-muted border-border"
      }`}
    >
      {label}
    </button>
  );
}

function formatQty(qty: number, type: "area" | "count" | "linear"): string {
  if (type === "count") return qty.toFixed(0);
  return qty.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
