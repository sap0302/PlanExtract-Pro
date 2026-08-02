import { NextResponse } from "next/server";
import { requireOwnedExtraction } from "@/lib/api-auth";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await requireOwnedExtraction(id, {
    pdfData: true,
    name: true,
    fileName: true,
    fileSize: true,
    provider: true,
  });
  if (!result.ok) return result.response;
  const { record: original } = result;

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
