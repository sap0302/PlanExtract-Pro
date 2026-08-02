import { NextResponse } from "next/server";
import { renderPdfPageToTiff } from "@/lib/pdf-utils";
import { requireOwnedExtraction } from "@/lib/api-auth";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; page: string }> }
) {
  const { id, page } = await params;
  const pageNumber = parseInt(page, 10);
  const isPreview = new URL(req.url).searchParams.get("preview") === "1";

  if (!Number.isFinite(pageNumber) || pageNumber < 1) {
    return NextResponse.json({ error: "Invalid page number" }, { status: 400 });
  }

  const result = await requireOwnedExtraction(id, { pdfData: true, fileName: true });
  if (!result.ok) return result.response;
  const { record: extraction } = result;

  if (!extraction.pdfData) {
    return NextResponse.json({ error: "PDF not stored for this extraction" }, { status: 404 });
  }

  try {
    const buffer = await renderPdfPageToTiff(
      extraction.pdfData,
      pageNumber,
      isPreview ? 1.0 : 2.0,
      isPreview ? "png" : "tiff"
    );

    const baseName = extraction.fileName.replace(/\.pdf$/i, "");
    if (isPreview) {
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "image/tiff",
        "Content-Disposition": `attachment; filename="${baseName}_page${pageNumber}.tif"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error(`[tif/${id.slice(0, 8)}] page ${pageNumber} render failed:`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "TIFF conversion failed" },
      { status: 500 }
    );
  }
}
