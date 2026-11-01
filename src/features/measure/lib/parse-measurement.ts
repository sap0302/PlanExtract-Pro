import type { Point } from "@/lib/measurement-utils";
import type { MeasurementShape } from "../components/measurement-canvas";

export function parseMeasurementRow(m: Record<string, unknown>): MeasurementShape {
  return {
    id: m.id as string,
    type: m.type as MeasurementShape["type"],
    points: JSON.parse(m.pointsJson as string) as Point[],
    page: m.page as number,
    color: m.color as string,
    label: m.label as string | undefined,
    valueFt: m.valueFt as number | null,
    valueCount: m.valueCount as number | null,
    itemId: (m.itemId as string | null) || null,
    shape: (m.shape as MeasurementShape["shape"]) || null,
  };
}
