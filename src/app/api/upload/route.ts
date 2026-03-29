import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Get filename from header or default
    const filename = request.headers.get("x-filename") || "upload.pdf";

    // Stream the request body directly to Vercel Blob (no buffering)
    const blob = await put(filename, request.body!, {
      access: "public",
      contentType: "application/pdf",
    });

    return NextResponse.json({
      url: blob.url,
      fileName: filename,
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
