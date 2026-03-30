import {
  put,
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

    const contentType = request.headers.get("content-type") || "";

    // JSON requests: create and complete multipart
    if (contentType.includes("application/json")) {
      const body = await request.json();
      const { action } = body;

      if (action === "create") {
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

      if (action === "complete") {
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

      // Simple upload for small files (< 4MB)
      if (action === "simple") {
        const { fileName, fileData } = body;
        const buffer = Buffer.from(fileData, "base64");
        const blob = await put(fileName, buffer, {
          access: "private",
          contentType: "application/pdf",
          addRandomSuffix: true,
        });
        return NextResponse.json({
          url: blob.url,
          pathname: blob.pathname,
        });
      }

      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    // Binary requests: upload a multipart part (raw body, no base64 overhead)
    if (contentType.includes("application/octet-stream")) {
      const uploadId = request.headers.get("x-upload-id") || "";
      const key = request.headers.get("x-upload-key") || "";
      const partNumber = parseInt(request.headers.get("x-part-number") || "1", 10);

      const buffer = Buffer.from(await request.arrayBuffer());

      const part = await uploadPart(key, buffer, {
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

    return NextResponse.json({ error: "Invalid content type" }, { status: 400 });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
