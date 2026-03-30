import {
  createMultipartUpload,
  uploadPart,
  completeMultipartUpload,
} from "@vercel/blob";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

export const maxDuration = 120;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { action } = body;

    if (action === "create") {
      // Step 1: Initialize multipart upload
      const { fileName } = body;
      const multipart = await createMultipartUpload(fileName, {
        access: "private",
        contentType: "application/pdf",
      });

      return NextResponse.json({
        uploadId: multipart.uploadId,
        key: multipart.key,
      });
    }

    if (action === "upload-part") {
      // Step 2: Upload a single part
      const { uploadId, key, partNumber, chunkData } = body;
      const chunkBuffer = Buffer.from(chunkData, "base64");

      const part = await uploadPart(key, chunkBuffer, {
        access: "private",
        uploadId,
        partNumber,
        key,
      });

      return NextResponse.json({
        etag: part.etag,
        partNumber: part.partNumber,
      });
    }

    if (action === "complete") {
      // Step 3: Complete the multipart upload
      const { uploadId, key, parts } = body;

      const blob = await completeMultipartUpload(key, parts, {
        access: "private",
        uploadId,
        key,
      });

      return NextResponse.json({
        url: blob.url,
        pathname: blob.pathname,
      });
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
