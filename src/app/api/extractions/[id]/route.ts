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
    omit: { rawResponse: true },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!extraction) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (extraction.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json(extraction);
}

export async function DELETE(
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
    select: { id: true, userId: true },
  });

  if (!extraction) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (extraction.userId !== session.user.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.extraction.delete({
    where: { id },
  });

  return new NextResponse(null, { status: 204 });
}
