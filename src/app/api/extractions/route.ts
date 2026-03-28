import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const extractions = await prisma.extraction.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    omit: { rawResponse: true },
    include: {
      _count: {
        select: {
          items: true,
        },
      },
    },
  });

  return NextResponse.json({ extractions });
}
