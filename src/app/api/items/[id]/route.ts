import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const updateItemSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).nullable().optional(),
  measurementType: z.enum(["area", "count", "linear"]).optional(),
  system: z.enum(["water", "storm_drain", "wastewater", "other"]).optional(),
  quantity: z.number().min(0).optional(),
  unit: z.enum(["SQ FT", "EA", "FT"]).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  costEach: z.number().min(0).optional(),
  markupPercent: z.number().min(0).max(100).optional(),
  priceEach: z.number().min(0).optional(),
  priceTotal: z.number().min(0).optional(),
  // Audit & traceability fields
  sourcePages: z.string().nullable().optional(),
  sourceSheetId: z.string().max(50).nullable().optional(),
  quantityMethod: z.enum(["station_math", "callout", "schedule", "count", "scale_estimate"]).nullable().optional(),
  evidence: z.string().max(1000).nullable().optional(),
  assumptions: z.string().nullable().optional(),
  dedupeKey: z.string().max(200).nullable().optional(),
  nodeRange: z.string().max(100).nullable().optional(),
  stationRange: z.string().max(100).nullable().optional(),
  isDemo: z.boolean().optional(),
  folderPath: z.string().max(100).nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Verify item exists and belongs to this user (via extraction)
    const item = await prisma.item.findUnique({
      where: { id },
      include: {
        extraction: {
          select: { userId: true },
        },
      },
    });

    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    if (item.extraction.userId !== session.user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const body = await req.json();
    const parsed = updateItemSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const updated = await prisma.item.update({
      where: { id },
      data: parsed.data,
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Item update error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Verify item exists and belongs to this user (via extraction)
    const item = await prisma.item.findUnique({
      where: { id },
      include: {
        extraction: {
          select: { userId: true },
        },
      },
    });

    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    if (item.extraction.userId !== session.user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    await prisma.item.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Item delete error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Something went wrong" },
      { status: 500 }
    );
  }
}
