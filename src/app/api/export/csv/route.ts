import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateInventoryCSV } from "@/lib/export-csv";
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

    const csv = generateInventoryCSV(extraction);

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${extraction.name.replace(/[^a-zA-Z0-9-_ ]/g, "")}_inventory.csv"`,
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to generate CSV" },
      { status: 500 }
    );
  }
}
