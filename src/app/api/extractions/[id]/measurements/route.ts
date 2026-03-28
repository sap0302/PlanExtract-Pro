import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  computePolylineLength,
  computePolygonArea,
} from "@/lib/measurement-utils";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const extraction = await prisma.extraction.findUnique({
    where: { id },
    select: { userId: true },
  });

  if (!extraction || extraction.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

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
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const extraction = await prisma.extraction.findUnique({
    where: { id },
    select: { userId: true, scalePixelsPerFoot: true },
  });

  if (!extraction || extraction.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const { type, points, page, label, color } = body;

  if (!["linear", "area", "count"].includes(type)) {
    return NextResponse.json({ error: "Invalid measurement type" }, { status: 400 });
  }

  if (!Array.isArray(points) || points.length === 0 || typeof page !== "number") {
    return NextResponse.json({ error: "Invalid measurement data" }, { status: 400 });
  }

  const ppf = extraction.scalePixelsPerFoot;
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
      extractionId: id,
    },
  });

  return NextResponse.json(measurement, { status: 201 });
}
