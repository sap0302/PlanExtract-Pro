import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwnedExtraction, requireSession } from "@/lib/api-auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Fetched with `omit`+`include` (full record minus pdfData, plus items) —
  // a third Prisma query shape the shared requireOwnedExtraction() helper
  // doesn't cover (it only handles `select`), so the ownership check stays
  // inline here rather than forcing this one call site into that generic.
  const sessionResult = await requireSession();
  if (!sessionResult.ok) return sessionResult.response;

  const { id } = await params;

  const extraction = await prisma.extraction.findUnique({
    where: { id },
    omit: { pdfData: true },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!extraction || extraction.userId !== sessionResult.session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(extraction);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await requireOwnedExtraction(id, {});
  if (!result.ok) return result.response;

  await prisma.extraction.delete({
    where: { id },
  });

  return new NextResponse(null, { status: 204 });
}
