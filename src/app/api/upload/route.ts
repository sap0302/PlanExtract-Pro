import { put, head, del } from "@vercel/blob";
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
    const { fileName, chunkData, chunkIndex, totalChunks, previousParts } = body;

    // Decode this chunk
    const chunkBuffer = Buffer.from(chunkData, "base64");

    // Collect all parts
    const parts: string[] = previousParts || [];

    // Upload this chunk as a temporary blob
    const partBlob = await put(`_parts/${fileName}-part${chunkIndex}`, chunkBuffer, {
      access: "private",
      contentType: "application/octet-stream",
      addRandomSuffix: true,
    });
    parts.push(partBlob.url);

    // If this is the last chunk, download all parts, merge, and upload final PDF
    if (parts.length === totalChunks) {
      const allBuffers: Buffer[] = [];
      for (const partUrl of parts) {
        // Use head() to get authenticated downloadUrl for private blobs
        const blobMeta = await head(partUrl);
        const res = await fetch(blobMeta.downloadUrl);
        if (!res.ok) throw new Error(`Failed to download part: ${res.status}`);
        allBuffers.push(Buffer.from(await res.arrayBuffer()));
      }
      const fullBuffer = Buffer.concat(allBuffers);

      // Upload the merged PDF
      const finalBlob = await put(fileName, fullBuffer, {
        access: "private",
        contentType: "application/pdf",
        addRandomSuffix: true,
      });

      // Clean up temp parts (fire and forget)
      del(parts).catch(() => {});

      return NextResponse.json({
        complete: true,
        url: finalBlob.url,
        fileName,
        fileSize: fullBuffer.length,
      });
    }

    // Return the parts list so client sends it back with next chunk
    return NextResponse.json({
      complete: false,
      parts,
      received: parts.length,
      total: totalChunks,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
