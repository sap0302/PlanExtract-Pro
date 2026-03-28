import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const extraction = await prisma.extraction.findUnique({
    where: { id },
    select: { pdfBlobUrl: true, userId: true, fileName: true },
  });

  if (!extraction || extraction.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!extraction.pdfBlobUrl) {
    return NextResponse.json(
      { error: "PDF not stored for this extraction" },
      { status: 404 }
    );
  }

  // Redirect to the Vercel Blob URL
  return NextResponse.redirect(extraction.pdfBlobUrl);
}
