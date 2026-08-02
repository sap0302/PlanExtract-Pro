import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { referenceExampleSchema } from "@/lib/validators";
import { requireOwnedReferenceExample } from "@/lib/api-auth";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await requireOwnedReferenceExample(id);
  if (!result.ok) return result.response;

  return NextResponse.json(result.record);
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await requireOwnedReferenceExample(id);
  if (!result.ok) return result.response;

  try {
    const body = await req.json();
    const validated = referenceExampleSchema.partial().parse(body);

    const updated = await prisma.referenceExample.update({
      where: { id },
      data: validated,
    });

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      return NextResponse.json({ error: "Invalid input", details: error }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await requireOwnedReferenceExample(id);
  if (!result.ok) return result.response;

  await prisma.referenceExample.delete({
    where: { id },
  });

  return NextResponse.json({ success: true });
}
