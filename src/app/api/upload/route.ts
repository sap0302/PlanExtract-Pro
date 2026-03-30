import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

// In-memory store for chunked uploads (keyed by uploadId)
const uploadChunks = new Map<string, { chunks: Buffer[]; fileName: string; totalChunks: number }>();

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const contentType = request.headers.get("content-type") || "";

    // JSON request = chunk metadata or init
    if (contentType.includes("application/json")) {
      const body = await request.json();
      const { action, uploadId, fileName, totalChunks, chunkIndex, chunkData } = body;

      if (action === "init") {
        // Initialize a new chunked upload
        const id = `${session.user.id}-${Date.now()}`;
        uploadChunks.set(id, {
          chunks: new Array(totalChunks).fill(null),
          fileName,
          totalChunks,
        });

        // Clean up after 5 minutes
        setTimeout(() => uploadChunks.delete(id), 5 * 60 * 1000);

        return NextResponse.json({ uploadId: id });
      }

      if (action === "chunk") {
        // Receive a chunk
        const upload = uploadChunks.get(uploadId);
        if (!upload) {
          return NextResponse.json({ error: "Upload not found or expired" }, { status: 404 });
        }

        upload.chunks[chunkIndex] = Buffer.from(chunkData, "base64");

        // Check if all chunks received
        const receivedCount = upload.chunks.filter(Boolean).length;
        if (receivedCount === upload.totalChunks) {
          // All chunks received — reassemble and upload to Vercel Blob
          const fullBuffer = Buffer.concat(upload.chunks);
          uploadChunks.delete(uploadId);

          const blob = await put(upload.fileName, fullBuffer, {
            access: "public",
            contentType: "application/pdf",
          });

          return NextResponse.json({
            complete: true,
            url: blob.url,
            fileName: upload.fileName,
            fileSize: fullBuffer.length,
          });
        }

        return NextResponse.json({
          complete: false,
          received: receivedCount,
          total: upload.totalChunks,
        });
      }

      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }

    return NextResponse.json({ error: "Invalid content type" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
