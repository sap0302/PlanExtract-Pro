"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MANUAL_MEASURE_SUFFIX } from "../lib/constants";
import { parseMeasurementRow } from "../lib/parse-measurement";
import type { ExtractionData, TargetItem } from "../types";
import type { MeasurementShape } from "../components/measurement-canvas";

export function useMeasureData(extractionId: string, targetItemId: string | null) {
  const [extraction, setExtraction] = useState<ExtractionData | null>(null);
  const [measurements, setMeasurements] = useState<MeasurementShape[]>([]);
  const [targetItem, setTargetItem] = useState<TargetItem | null>(null);
  const [loading, setLoading] = useState(true);
  const undoStack = useRef<string[]>([]);

  const refreshMeasurements = useCallback(async () => {
    try {
      const res = await fetch(`/api/extractions/${extractionId}/measurements`);
      if (!res.ok) return;
      const { measurements: meas } = await res.json();
      setMeasurements(meas.map((m: Record<string, unknown>) => parseMeasurementRow(m)));
    } catch {
      // non-fatal — worst case the just-recomputed values only show up after reload
    }
  }, [extractionId]);

  useEffect(() => {
    const load = async () => {
      try {
        const fetches: Array<Promise<Response>> = [
          fetch(`/api/extractions/${extractionId}`),
          fetch(`/api/extractions/${extractionId}/measurements`),
        ];
        if (targetItemId) fetches.push(fetch(`/api/items/${targetItemId}`));

        const [extRes, measRes, itemRes] = await Promise.all(fetches);

        if (extRes.ok) setExtraction(await extRes.json());

        if (measRes.ok) {
          const { measurements: meas } = await measRes.json();
          const parsed = meas.map((m: Record<string, unknown>) => parseMeasurementRow(m));
          setMeasurements(parsed);
          undoStack.current = parsed.map((m: MeasurementShape) => m.id);
        }

        if (itemRes && itemRes.ok) {
          const itemData = await itemRes.json();
          const rawName = itemData.name as string;
          const cleanName = rawName.endsWith(MANUAL_MEASURE_SUFFIX)
            ? rawName.slice(0, -MANUAL_MEASURE_SUFFIX.length)
            : rawName;
          setTargetItem({
            id: itemData.id,
            name: cleanName,
            originalName: rawName,
            measurementType: itemData.measurementType,
            system: itemData.system,
            unit: itemData.unit,
            sourceSheetId: itemData.sourceSheetId,
            evidence: itemData.evidence || null,
          });
        } else if (targetItemId && itemRes && !itemRes.ok) {
          toast.error("Could not load target item for measurement");
        }
      } catch {
        toast.error("Failed to load measurement data");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [extractionId, targetItemId]);

  return {
    extraction,
    setExtraction,
    measurements,
    setMeasurements,
    targetItem,
    setTargetItem,
    loading,
    undoStack,
    refreshMeasurements,
  };
}
