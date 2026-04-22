import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/encryption";
import { renderPdfToImages } from "@/lib/pdf-utils";
import { analyzeImage, type AIAssistConfig } from "@/lib/ai-assist";
import type { Provider } from "@/lib/validators";

interface RegionResult {
  regions: Array<{
    bbox: [number, number, number, number]; // [x1, y1, x2, y2] in image pixels
    label: string;
    confidence: number;
  }>;
}

export interface RegionHighlight {
  bbox: [number, number, number, number]; // PDF-space coords
  label: string;
  confidence: number;
  page: number;
}

const RENDER_SCALE = 2.5; // 180 DPI — same as Surya OCR, good balance

function buildRegionPrompt(
  itemName: string,
  pageNum: number,
  evidence?: string,
  measurementType?: string
): string {
  return `This is page ${pageNum} of a civil engineering plan sheet.
Find ALL instances of the following item on this sheet:

Item: "${itemName}"
Type: ${measurementType || "unknown"} measurement
${evidence ? `Additional context from extraction: "${evidence.slice(0, 500)}"` : ""}

For each instance found, return a bounding box in pixel coordinates (relative to the image).
The bounding box should encompass the area where this item appears on the plan.

Return JSON:
{
  "regions": [
    {
      "bbox": [x1, y1, x2, y2],
      "label": "brief location description, e.g., near STA 1+50 or at NW corner",
      "confidence": 0.85
    }
  ]
}

If no instances are found on this page, return: { "regions": [] }

IMPORTANT:
- bbox coordinates are [left, top, right, bottom] in pixels relative to this image.
- Include ALL instances visible on the sheet, not just the first one.
- For pipes/lines, the bbox should encompass the full visible run on this sheet.
- For areas (rip rap, concrete), the bbox should encompass the entire hatched/marked region.
- For individual items (valves, manholes, bends), use a tight box around each one.
- Be generous with the bounding box — slightly too large is better than cutting off the item.`;
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { extractionId, itemName, itemEvidence, page, measurementType } =
      body as {
        extractionId: string;
        itemName: string;
        itemEvidence?: string;
        page?: number;
        measurementType?: string;
      };

    if (!extractionId || !itemName) {
      return NextResponse.json(
        { error: "extractionId and itemName are required" },
        { status: 400 }
      );
    }

    // Load extraction with PDF data
    const extraction = await prisma.extraction.findUnique({
      where: { id: extractionId },
      select: {
        id: true,
        userId: true,
        pdfData: true,
        pageCount: true,
      },
    });

    if (!extraction || extraction.userId !== session.user.id) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (!extraction.pdfData) {
      return NextResponse.json(
        { error: "No PDF data stored for this extraction" },
        { status: 400 }
      );
    }

    // Resolve user's AI provider + API key
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        anthropicKeyEnc: true,
        openaiKeyEnc: true,
        geminiKeyEnc: true,
        preferredProvider: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const provider = (user.preferredProvider || "anthropic") as Provider;
    const keyFieldMap: Record<Provider, string | null> = {
      anthropic: user.anthropicKeyEnc,
      openai: user.openaiKeyEnc,
      gemini: user.geminiKeyEnc,
    };
    const enc = keyFieldMap[provider];
    let apiKey: string | null = null;
    if (enc) {
      try {
        apiKey = decrypt(enc);
      } catch {
        apiKey = null;
      }
    }
    if (!apiKey && provider === "anthropic") {
      apiKey = process.env.ANTHROPIC_API_KEY || null;
    }
    if (!apiKey) {
      return NextResponse.json(
        { error: `No API key configured for ${provider}` },
        { status: 400 }
      );
    }

    const config: AIAssistConfig = { provider, apiKey };

    // Determine which pages to search
    const maxPage = extraction.pageCount || 20;
    const pagesToSearch = page
      ? [page]
      : Array.from({ length: Math.min(5, maxPage) }, (_, i) => i + 1);

    const pdfBuffer = Buffer.from(extraction.pdfData);
    const allRegions: RegionHighlight[] = [];

    for (const pageNum of pagesToSearch) {
      try {
        console.log(
          `[regions] Searching page ${pageNum} for "${itemName}"...`
        );

        const images = await renderPdfToImages(pdfBuffer, RENDER_SCALE, {
          start: pageNum,
          end: pageNum,
        });

        if (!images.length) continue;

        const jpegBase64 = images[0].toString("base64");
        const prompt = buildRegionPrompt(
          itemName,
          pageNum,
          itemEvidence,
          measurementType
        );

        const result = await analyzeImage<RegionResult>(
          config,
          jpegBase64,
          prompt,
          1024
        );

        if (result.regions?.length) {
          for (const region of result.regions) {
            if ((region.confidence ?? 0) < 0.5) continue;

            // Convert pixel coords to PDF-space (divide by render scale)
            const pdfBbox: [number, number, number, number] = [
              region.bbox[0] / RENDER_SCALE,
              region.bbox[1] / RENDER_SCALE,
              region.bbox[2] / RENDER_SCALE,
              region.bbox[3] / RENDER_SCALE,
            ];

            allRegions.push({
              bbox: pdfBbox,
              label: region.label || `Page ${pageNum}`,
              confidence: region.confidence,
              page: pageNum,
            });
          }
          console.log(
            `[regions] Page ${pageNum}: found ${result.regions.length} region(s)`
          );
        } else {
          console.log(`[regions] Page ${pageNum}: no regions found`);
        }
      } catch (err) {
        console.warn(
          `[regions] Page ${pageNum} failed:`,
          err instanceof Error ? err.message : err
        );
        // Continue to next page
      }
    }

    // Sort by confidence descending
    allRegions.sort((a, b) => b.confidence - a.confidence);

    console.log(
      `[regions] Total: ${allRegions.length} region(s) for "${itemName}"`
    );

    return NextResponse.json({ regions: allRegions });
  } catch (error) {
    console.error("[regions] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Region detection failed",
      },
      { status: 500 }
    );
  }
}
