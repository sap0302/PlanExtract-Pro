import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const UNIT_MAP: Record<string, string> = {
  area: "SQ FT",
  count: "EA",
  linear: "FT",
};

const createItemSchema = z.object({
  extractionId: z.string().min(1),
  measurementType: z.enum(["area", "count", "linear"]),
  name: z.string().min(1).max(200).optional().default("New Item"),
  system: z
    .enum(["water", "storm_drain", "wastewater", "other"])
    .optional()
    .default("other"),
  quantity: z.number().min(0).optional().default(0),
  unit: z.enum(["SQ FT", "EA", "FT"]).optional(),
  description: z.string().max(500).nullable().optional(),
  // Audit & traceability fields
  sourceSheetId: z.string().max(50).nullable().optional(),
  quantityMethod: z.enum(["station_math", "callout", "schedule", "count", "scale_estimate"]).nullable().optional(),
  isDemo: z.boolean().optional().default(false),
  folderPath: z.string().max(100).nullable().optional(),
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const parsed = createItemSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { extractionId, measurementType, name, system, quantity, description } =
      parsed.data;

    // Verify extraction exists and belongs to this user
    const extraction = await prisma.extraction.findUnique({
      where: { id: extractionId },
      select: { userId: true },
    });

    if (!extraction) {
      return NextResponse.json(
        { error: "Extraction not found" },
        { status: 404 }
      );
    }

    if (extraction.userId !== session.user.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Get the next sortOrder
    const maxSortOrder = await prisma.item.aggregate({
      where: { extractionId },
      _max: { sortOrder: true },
    });
    const nextSortOrder = (maxSortOrder._max.sortOrder ?? -1) + 1;

    // Auto-set unit from measurementType if not provided
    const unit = parsed.data.unit || UNIT_MAP[measurementType] || "EA";

    const item = await prisma.item.create({
      data: {
        name,
        measurementType,
        system,
        quantity,
        unit,
        description: description || null,
        confidence: "medium",
        costEach: 0,
        markupPercent: 0,
        priceEach: 0,
        priceTotal: 0,
        sortOrder: nextSortOrder,
        extractionId,
      },
    });

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    console.error("Item create error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Something went wrong",
      },
      { status: 500 }
    );
  }
}
