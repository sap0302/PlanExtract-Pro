import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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
    select: { id: true, userId: true },
  });

  if (!extraction || extraction.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const { page, points, distanceFt, pdfWidth, pdfHeight } = body;

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

  await prisma.extraction.update({
    where: { id },
    data: {
      scalePixelsPerFoot: pixelsPerFoot,
      scaleCalibrationJson: calibrationJson,
    },
  });

  return NextResponse.json({
    pixelsPerFoot,
    scaleDescription: `1 pixel = ${(1 / pixelsPerFoot).toFixed(4)} ft`,
  });
}
