import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateInventoryCSV } from "@/lib/export-csv";

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { extractionId } = await req.json();

    const extraction = await prisma.extraction.findUnique({
      where: { id: extractionId },
      omit: { pdfData: true },
      include: {
        items: { orderBy: { sortOrder: "asc" } },
      },
    });

    if (!extraction || extraction.userId !== session.user.id) {
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
