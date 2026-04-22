import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const extraction = await prisma.extraction.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true, finalized: true },
    });

    if (!extraction || extraction.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

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
