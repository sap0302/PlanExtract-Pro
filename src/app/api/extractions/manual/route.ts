import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getPdfPageCount } from "@/lib/pdf-utils";

/**
 * Creates an Extraction record for "Manual mode" — no AI call at all, just
 * stores the PDF and jumps straight to the measure/takeoff UI so the user
 * can draw every item by hand. Mirrors the fields /api/extract sets, minus
 * anything AI-provider-related.
 */
export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const name = (formData.get("name") as string) || "Untitled Extraction";

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    if (file.type !== "application/pdf") {
      return NextResponse.json({ error: "Only PDF files are accepted" }, { status: 400 });
    }
    const maxSize = 150 * 1024 * 1024; // 150MB
    if (file.size > maxSize) {
      return NextResponse.json({ error: "File size exceeds 150MB limit" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const rawBuffer = Buffer.from(arrayBuffer);

    let pageCount: number | null = null;
    try {
      pageCount = await getPdfPageCount(rawBuffer);
    } catch {
      // Non-fatal — the measure page's PdfViewer reports the true page
      // count client-side once it loads the PDF anyway.
    }

    const extraction = await prisma.extraction.create({
      data: {
        name,
        fileName: file.name,
        fileSize: file.size,
        status: "completed",
        provider: "manual",
        pdfData: rawBuffer,
        pageCount,
        userId: session.user.id,
      },
    });

    return NextResponse.json({ extractionId: extraction.id });
  } catch (error) {
    console.error("[extractions/manual] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create manual extraction" },
      { status: 500 }
    );
  }
}
