import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  computePolylineLength,
  computePolygonArea,
} from "@/lib/measurement-utils";
import { requireOwnedExtraction } from "@/lib/api-auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await requireOwnedExtraction(id, {});
  if (!result.ok) return result.response;

  const measurements = await prisma.measurement.findMany({
    where: { extractionId: id },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ measurements });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await requireOwnedExtraction(id, {
    scalePixelsPerFoot: true,
    scalePerPageJson: true,
  });
  if (!result.ok) return result.response;
  const { record: extraction } = result;

  const body = await req.json();
  const { type, points, page, label, color, shape } = body;

  if (!["linear", "area", "count"].includes(type)) {
    return NextResponse.json({ error: "Invalid measurement type" }, { status: 400 });
  }

  if (!Array.isArray(points) || points.length === 0 || typeof page !== "number") {
    return NextResponse.json({ error: "Invalid measurement data" }, { status: 400 });
  }

  // Per-page scale (set by calibrating a page without "Apply Scale to all
  // pages") overrides the global scalePixelsPerFoot for that page — this
  // route was written before that feature existed and always used the
  // global value only, so a measurement drawn on a page with just a
  // per-page override (and no global scale) silently saved as 0.00 FT.
  let ppf = extraction.scalePixelsPerFoot;
  if (extraction.scalePerPageJson) {
    try {
      const perPage = JSON.parse(extraction.scalePerPageJson) as Record<string, number>;
      if (perPage[String(page)] != null) ppf = perPage[String(page)];
    } catch {
      // fall back to global ppf
    }
  }
  let valueFt: number | null = null;
  let valueCount: number | null = null;

  if (type === "linear" && ppf && points.length >= 2) {
    valueFt = computePolylineLength(points, ppf);
  } else if (type === "area" && ppf && points.length >= 3) {
    valueFt = computePolygonArea(points, ppf);
  } else if (type === "count") {
    valueCount = 1;
  }

  const measurement = await prisma.measurement.create({
    data: {
      type,
      label: label || null,
      pointsJson: JSON.stringify(points),
      page,
      valueFt,
      valueCount,
      color: color || "#FF0000",
      shape: type === "count" ? shape || null : null,
      extractionId: id,
    },
  });

  return NextResponse.json(measurement, { status: 201 });
}
