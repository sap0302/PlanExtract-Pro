import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateInventoryPDF } from "@/lib/export-pdf";
import { requireSession } from "@/lib/api-auth";

export async function POST(req: Request) {
  try {
    const sessionResult = await requireSession();
    if (!sessionResult.ok) return sessionResult.response;

    const { extractionId } = await req.json();

    const extraction = await prisma.extraction.findUnique({
      where: { id: extractionId },
      omit: { pdfData: true },
      include: {
        items: { orderBy: { sortOrder: "asc" } },
      },
    });

    if (!extraction || extraction.userId !== sessionResult.session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const pdfBuffer = generateInventoryPDF(extraction);
    const uint8 = new Uint8Array(pdfBuffer);

    return new NextResponse(uint8, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${extraction.name.replace(/[^a-zA-Z0-9-_ ]/g, "")}_inventory.pdf"`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to generate PDF" },
      { status: 500 }
    );
  }
}
