import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const measurement = await prisma.measurement.findUnique({
    where: { id },
    include: { extraction: { select: { userId: true } } },
  });

  if (!measurement || measurement.extraction.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const { label, color, itemId } = body;

  const updated = await prisma.measurement.update({
    where: { id },
    data: {
      ...(label !== undefined && { label }),
      ...(color !== undefined && { color }),
      ...(itemId !== undefined && { itemId: itemId || null }),
    },
  });

  return NextResponse.json(updated);
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

  const measurement = await prisma.measurement.findUnique({
    where: { id },
    include: { extraction: { select: { userId: true } } },
  });

  if (!measurement || measurement.extraction.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.measurement.delete({ where: { id } });

  return new NextResponse(null, { status: 204 });
}
