import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computePolylineLength, computePolygonArea } from "@/lib/measurement-utils";
import { requireOwnedExtraction } from "@/lib/api-auth";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await requireOwnedExtraction(id, {
    scalePerPageJson: true,
    scalePixelsPerFoot: true,
  });
  if (!result.ok) return result.response;
  const { record: extraction } = result;

  const body = await req.json();
  const { page, points, distanceFt, pdfWidth, pdfHeight, applyToAllPages } = body;

  if (
    !Array.isArray(points) ||
    points.length !== 2 ||
    typeof distanceFt !== "number" ||
    distanceFt <= 0
  ) {
    return NextResponse.json(
      { error: "Invalid calibration data" },
      { status: 400 }
    );
  }

  // Compute pixel distance between the two calibration points
  const dx = points[1].x - points[0].x;
  const dy = points[1].y - points[0].y;
  const pixelDistance = Math.sqrt(dx * dx + dy * dy);

  if (pixelDistance < 1) {
    return NextResponse.json(
      { error: "Calibration points are too close together" },
      { status: 400 }
    );
  }

  const pixelsPerFoot = pixelDistance / distanceFt;

  const calibrationJson = JSON.stringify({
    page,
    points,
    distanceFt,
    pdfWidth,
    pdfHeight,
    pixelDistance,
  });

  // "Apply Scale to all pages" writes the global fallback used by any page
  // without its own override. Otherwise, this calibration only applies to
  // the specific page it was drawn on — merged into a per-page JSON map so
  // other pages (and any of their own overrides) are left untouched.
  let perPage: Record<string, number> = {};
  if (extraction.scalePerPageJson) {
    try {
      perPage = JSON.parse(extraction.scalePerPageJson);
    } catch {
      perPage = {};
    }
  }
  let newGlobalPpf = extraction.scalePixelsPerFoot;

  if (applyToAllPages) {
    newGlobalPpf = pixelsPerFoot;
    await prisma.extraction.update({
      where: { id },
      data: {
        scalePixelsPerFoot: pixelsPerFoot,
        scaleCalibrationJson: calibrationJson,
      },
    });
  } else {
    perPage[String(page)] = pixelsPerFoot;
    await prisma.extraction.update({
      where: { id },
      data: {
        scalePerPageJson: JSON.stringify(perPage),
        scaleCalibrationJson: calibrationJson,
      },
    });
  }

  // Retroactively fix measurements drawn BEFORE any scale existed for their
  // page — those were saved with valueFt null/0 since there was nothing to
  // compute against at the time. Now that this calibration may have given
  // them a resolvable scale (their own per-page override, or this new
  // global fallback), recompute from their stored points instead of leaving
  // them stuck at 0.00 FT / 0.00 SQ FT forever.
  const staleMeasurements = await prisma.measurement.findMany({
    where: {
      extractionId: id,
      type: { in: ["linear", "area"] },
      OR: [{ valueFt: null }, { valueFt: 0 }],
    },
  });

  for (const m of staleMeasurements) {
    const effectivePpf = perPage[String(m.page)] ?? newGlobalPpf;
    if (!effectivePpf) continue; // still uncalibrated for this measurement's page

    try {
      const pts = JSON.parse(m.pointsJson) as Array<{ x: number; y: number }>;
      let newValueFt: number | null = null;
      if (m.type === "linear" && pts.length >= 2) {
        newValueFt = computePolylineLength(pts, effectivePpf);
      } else if (m.type === "area" && pts.length >= 3) {
        newValueFt = computePolygonArea(pts, effectivePpf);
      }
      if (newValueFt != null && newValueFt !== m.valueFt) {
        await prisma.measurement.update({
          where: { id: m.id },
          data: { valueFt: newValueFt },
        });
      }
    } catch {
      // malformed pointsJson — skip, nothing sensible to recompute
    }
  }

  return NextResponse.json({
    pixelsPerFoot,
    scaleDescription: `1 pixel = ${(1 / pixelsPerFoot).toFixed(4)} ft`,
  });
}
