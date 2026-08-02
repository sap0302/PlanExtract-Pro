import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwnedExtraction } from "@/lib/api-auth";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const result = await requireOwnedExtraction(id, { status: true, finalized: true });
    if (!result.ok) return result.response;
    const { record: extraction } = result;

    if (extraction.status !== "completed") {
      return NextResponse.json(
        { error: "Only completed extractions can be finalized" },
        { status: 400 }
      );
    }

    if (extraction.finalized) {
      return NextResponse.json(
        { error: "Extraction is already finalized" },
        { status: 400 }
      );
    }

    await prisma.extraction.update({
      where: { id },
      data: {
        finalized: true,
        finalizedAt: new Date(),
      },
    });

    console.log(`[learning] Extraction ${id} finalized`);

    return NextResponse.json({ success: true, finalized: true });
  } catch (error) {
    console.error("Finalize error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to finalize" },
      { status: 500 }
    );
  }
}
