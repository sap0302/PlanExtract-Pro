import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const maxDuration = 120;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { action } = body;

    // Step 1: Client sends a chunk to be stored in DB
    if (action === "chunk") {
      const { uploadId, chunkIndex, totalChunks, fileName, chunkData } = body;

      // Store chunk in a temporary DB table
      // Using ReferenceExample as scratch storage would be messy,
      // so we use raw SQL to create/use a temp chunks table
      await prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "UploadChunk" (
          "uploadId" TEXT NOT NULL,
          "chunkIndex" INTEGER NOT NULL,
          "data" TEXT NOT NULL,
          "fileName" TEXT NOT NULL,
          "totalChunks" INTEGER NOT NULL,
          "createdAt" TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY ("uploadId", "chunkIndex")
        )`
      );

      await prisma.$executeRawUnsafe(
        `INSERT INTO "UploadChunk" ("uploadId", "chunkIndex", "data", "fileName", "totalChunks")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("uploadId", "chunkIndex") DO UPDATE SET "data" = $3`,
        uploadId, chunkIndex, chunkData, fileName, totalChunks
      );

      // Check if all chunks are received
      const result = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) as count FROM "UploadChunk" WHERE "uploadId" = $1`,
        uploadId
      ) as Array<{ count: bigint }>;

      const received = Number(result[0].count);

      if (received === totalChunks) {
        // All chunks received — fetch, merge, upload to blob
        const chunks = await prisma.$queryRawUnsafe(
          `SELECT "data", "chunkIndex" FROM "UploadChunk"
           WHERE "uploadId" = $1 ORDER BY "chunkIndex" ASC`,
          uploadId
        ) as Array<{ data: string; chunkIndex: number }>;

        const buffers = chunks.map((c) => Buffer.from(c.data, "base64"));
        const fullBuffer = Buffer.concat(buffers);

        // Upload to Vercel Blob
        const blob = await put(fileName, fullBuffer, {
          access: "private",
          contentType: "application/pdf",
          addRandomSuffix: true,
        });

        // Clean up chunks
        await prisma.$executeRawUnsafe(
          `DELETE FROM "UploadChunk" WHERE "uploadId" = $1`,
          uploadId
        );

        return NextResponse.json({
          complete: true,
          url: blob.url,
          fileName,
          fileSize: fullBuffer.length,
        });
      }

      return NextResponse.json({
        complete: false,
        received,
        total: totalChunks,
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
