import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwnedMeasurement } from "@/lib/api-auth";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await requireOwnedMeasurement(id);
  if (!result.ok) return result.response;

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
  const { id } = await params;

  const result = await requireOwnedMeasurement(id);
  if (!result.ok) return result.response;

  await prisma.measurement.delete({ where: { id } });

  return new NextResponse(null, { status: 204 });
}
