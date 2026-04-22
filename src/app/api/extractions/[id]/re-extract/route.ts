import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const original = await prisma.extraction.findUnique({
    where: { id },
    select: {
      pdfData: true,
      userId: true,
      name: true,
      fileName: true,
      fileSize: true,
      provider: true,
    },
  });

  if (!original || original.userId !== session.user.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!original.pdfData) {
    return NextResponse.json(
      { error: "No PDF stored for this extraction. Upload the plan again." },
      { status: 400 }
    );
  }

  // Build FormData with the stored PDF and call our own extract API
  const formData = new FormData();
  const blob = new Blob([original.pdfData], { type: "application/pdf" });
  formData.append("file", blob, original.fileName);
  formData.append("name", original.name);

  // Use the same provider (strip consensus prefix)
  const provider = original.provider.startsWith("consensus") ? "" : original.provider;
  if (provider) formData.append("provider", provider);

  // Forward the request to the extract endpoint
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const extractRes = await fetch(`${baseUrl}/api/extract`, {
    method: "POST",
    headers: {
      cookie: req.headers.get("cookie") || "",
    },
    body: formData,
  });

  const data = await extractRes.json();

  if (!extractRes.ok) {
    return NextResponse.json(
      { error: data.error || "Re-extraction failed" },
      { status: extractRes.status }
    );
  }

  return NextResponse.json(data);
}
