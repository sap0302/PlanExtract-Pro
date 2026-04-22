import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const logPrefix = `[pdf/${id.slice(0, 8)}]`;
  const t0 = Date.now();

  const session = await auth();
  if (!session?.user?.id) {
    console.log(`${logPrefix} 401 unauthorized`);
    return NextResponse.json(
      { error: "Unauthorized", reason: "unauthorized" },
      { status: 401 }
    );
  }

  console.log(`${logPrefix} start — loading blob from DB...`);
  let extraction;
  try {
    extraction = await prisma.extraction.findUnique({
      where: { id },
      select: { pdfData: true, userId: true, fileName: true },
    });
  } catch (dbErr) {
    console.error(`${logPrefix} Prisma query failed after ${Date.now() - t0}ms:`, dbErr);
    return NextResponse.json(
      { error: "Database query failed", reason: "db_error", detail: dbErr instanceof Error ? dbErr.message : String(dbErr) },
      { status: 500 }
    );
  }

  const queryMs = Date.now() - t0;

  if (!extraction || extraction.userId !== session.user.id) {
    console.log(`${logPrefix} 404 not found (${queryMs}ms)`);
    return NextResponse.json(
      { error: "Extraction not found", reason: "not_found" },
      { status: 404 }
    );
  }

  if (!extraction.pdfData) {
    console.log(`${logPrefix} 404 pdfData is NULL (${queryMs}ms)`);
    return NextResponse.json(
      {
        error: "PDF not stored for this extraction",
        reason: "not_stored",
        fileName: extraction.fileName,
      },
      { status: 404 }
    );
  }

  const sizeBytes = extraction.pdfData.length;
  const sizeMB = sizeBytes / 1024 / 1024;
  console.log(
    `${logPrefix} DB query: ${queryMs}ms, pdfData: ${sizeMB.toFixed(1)} MB — sending response`
  );

  // Stream the buffer so large PDFs don't block the Node event loop while
  // the whole body is serialized. For a 100+ MB PDF this is the difference
  // between a stable response and a "failed to fetch" after timeout.
  const buffer = extraction.pdfData;
  const stream = new ReadableStream({
    start(controller) {
      // Send in ~1 MB chunks so backpressure works and the browser can start
      // consuming before the full payload is in the pipe.
      const CHUNK = 1024 * 1024;
      let offset = 0;
      const push = () => {
        if (offset >= buffer.length) {
          controller.close();
          console.log(
            `${logPrefix} response complete (${Date.now() - t0}ms total)`
          );
          return;
        }
        const end = Math.min(offset + CHUNK, buffer.length);
        controller.enqueue(new Uint8Array(buffer.subarray(offset, end)));
        offset = end;
        // Schedule next chunk on microtask so we don't starve other work
        queueMicrotask(push);
      };
      push();
    },
    cancel() {
      console.log(`${logPrefix} response cancelled by client`);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(sizeBytes),
      "Content-Disposition": `inline; filename="${extraction.fileName}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
