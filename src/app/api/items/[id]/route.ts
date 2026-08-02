import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwnedItem } from "@/lib/api-auth";
import { z } from "zod";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await requireOwnedItem(id);
    if (!result.ok) return result.response;

    return NextResponse.json(result.record);
  } catch (error) {
    console.error("Item GET error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Something went wrong" },
      { status: 500 }
    );
  }
}

const updateItemSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).nullable().optional(),
  measurementType: z.enum(["area", "count", "linear"]).optional(),
  system: z.enum(["water", "storm_drain", "wastewater", "other"]).optional(),
  quantity: z.number().min(0).max(999999).optional(),
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
    const { id } = await params;

    const result = await requireOwnedItem(id);
    if (!result.ok) return result.response;
    const { record: item, session } = result;

    const body = await req.json();
    const parsed = updateItemSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid data", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // ── Learning system: capture corrections before overwriting ──
    let corrections: Array<{
      correctionType: string;
      fieldName: string;
      originalValue: string | null;
      correctedValue: string | null;
    }> = [];

    // Special case: user-added item getting its first real name
    // This means "AI missed this item entirely" — the most valuable signal
    if (
      item.originalAiQuantity == null &&
      item.name === "New Item" &&
      parsed.data.name &&
      parsed.data.name !== "New Item"
    ) {
      corrections = [
        {
          correctionType: "added",
          fieldName: "item",
          originalValue: null,
          correctedValue: `${parsed.data.name} (qty: ${parsed.data.quantity ?? item.quantity})`,
        },
      ];
    } else {
      // Track extraction-accuracy fields only (not pricing)
      const trackedFields = ["quantity", "name", "system", "measurementType", "confidence"] as const;
      for (const field of trackedFields) {
        if (parsed.data[field] !== undefined) {
          const oldVal = String(item[field] ?? "");
          const newVal = String(parsed.data[field] ?? "");
          if (oldVal !== newVal) {
            corrections.push({
              correctionType: field === "quantity" ? "quantity" : "name",
              fieldName: field,
              originalValue: oldVal,
              correctedValue: newVal,
            });
          }
        }
      }
    }

    // Snapshot original AI values on first edit (if not already set)
    const snapshotData: Record<string, unknown> = { ...parsed.data };
    if (item.originalAiQuantity == null && parsed.data.quantity !== undefined) {
      snapshotData.originalAiQuantity = item.quantity;
    }
    if (item.originalAiName == null && parsed.data.name !== undefined) {
      snapshotData.originalAiName = item.name;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.item.update({
        where: { id },
        data: snapshotData,
      });

      // Save correction records
      if (corrections.length > 0) {
        await tx.correction.createMany({
          data: corrections.map((c) => ({
            itemId: id,
            extractionId: item.extractionId,
            userId: session.user.id,
            correctionType: c.correctionType,
            fieldName: c.fieldName,
            originalValue: c.originalValue,
            correctedValue: c.correctedValue,
            itemName: item.name,
            itemSystem: item.system,
            measurementType: item.measurementType,
            quantityMethod: item.quantityMethod,
          })),
        });

        // Increment extraction correction count
        await tx.extraction.update({
          where: { id: item.extractionId },
          data: { correctionCount: { increment: corrections.length } },
        });

        console.log(
          `[learning] ${corrections.length} correction(s) on "${item.name}": ` +
            corrections.map((c) => `${c.fieldName} ${c.originalValue} → ${c.correctedValue}`).join(", ")
        );
      }

      return result;
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
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await requireOwnedItem(id);
    if (!result.ok) return result.response;
    const { record: item, session } = result;

    // ── Learning system: record deletion as correction ──
    // Parse optional reason from request body
    const body = await req.json().catch(() => ({}));
    const reason = (body as Record<string, unknown>).reason as string | undefined;

    // Only track AI-extracted items (those with originalAiQuantity set)
    if (item.originalAiQuantity != null) {
      // Map reason to correction type:
      // "not_on_plans" → AI hallucinated (strong learning signal)
      // "not_in_scope" → AI was right but item not needed (no negative signal)
      // undefined → legacy/ambiguous
      const correctionType =
        reason === "not_on_plans"
          ? "deleted_hallucinated"
          : reason === "not_in_scope"
            ? "deleted_out_of_scope"
            : "deleted";

      await prisma.$transaction(async (tx) => {
        await tx.correction.create({
          data: {
            itemId: id,
            extractionId: item.extractionId,
            userId: session.user.id,
            correctionType,
            fieldName: "item",
            originalValue: `${item.name} (qty: ${item.quantity})`,
            correctedValue: reason || null,
            itemName: item.name,
            itemSystem: item.system,
            measurementType: item.measurementType,
            quantityMethod: item.quantityMethod,
          },
        });
        await tx.extraction.update({
          where: { id: item.extractionId },
          data: { correctionCount: { increment: 1 } },
        });
        // The Item↔Measurement relation is onDelete: SetNull — deleting the
        // item alone would just unlink it, leaving the drawn shape sitting
        // on the plan. Delete its linked measurement(s) too so removing an
        // item actually removes what it was measured from.
        await tx.measurement.deleteMany({ where: { itemId: id } });
        await tx.item.delete({ where: { id } });
      });
      console.log(
        `[learning] Deleted AI item: "${item.name}" (reason: ${correctionType})`
      );
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.measurement.deleteMany({ where: { itemId: id } });
        await tx.item.delete({ where: { id } });
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Item delete error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Something went wrong" },
      { status: 500 }
    );
  }
}
