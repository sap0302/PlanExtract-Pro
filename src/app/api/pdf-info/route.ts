import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPdfPageCount } from "@/lib/pdf-utils";

/**
 * POST /api/pdf-info
 * Accepts a PDF file and returns page count and whether it needs splitting.
 */
export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.type !== "application/pdf") {
      return NextResponse.json(
        { error: "Only PDF files are accepted" },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const pageCount = await getPdfPageCount(buffer);

    // A PDF needs splitting if its base64 size would exceed ~20MB
    const estimatedBase64Size = Math.ceil(buffer.length * 1.34);
    const needsSplitting = estimatedBase64Size > 20 * 1024 * 1024;

    return NextResponse.json({
      pageCount,
      fileSize: file.size,
      needsSplitting,
    });
  } catch (error) {
    console.error("PDF info error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to read PDF information",
      },
      { status: 500 }
    );
  }
}
