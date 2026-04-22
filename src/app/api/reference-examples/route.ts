import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { referenceExampleSchema } from "@/lib/validators";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const referenceExamples = await prisma.referenceExample.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ referenceExamples });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const validated = referenceExampleSchema.parse(body);

    // Enforce max 20 examples per user (manual + auto-generated combined)
    const count = await prisma.referenceExample.count({
      where: { userId: session.user.id },
    });
    if (count >= 20) {
      return NextResponse.json(
        { error: "Maximum of 20 reference examples allowed. Delete or deactivate one before adding another." },
        { status: 400 }
      );
    }

    const example = await prisma.referenceExample.create({
      data: {
        name: validated.name,
        projectType: validated.projectType,
        rawText: validated.rawText,
        isActive: validated.isActive ?? true,
        userId: session.user.id,
      },
    });

    return NextResponse.json(example, { status: 201 });
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
