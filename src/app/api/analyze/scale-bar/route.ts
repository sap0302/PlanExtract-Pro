import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/encryption";
import { renderPdfToImages } from "@/lib/pdf-utils";
import { analyzeImage, type AIAssistConfig } from "@/lib/ai-assist";
import type { Provider } from "@/lib/validators";
import { requireOwnedExtraction } from "@/lib/api-auth";

interface ScaleBarResult {
  found: boolean;
  notation?: string;
  feetPerInch?: number;
  barStartPixel?: { x: number; y: number };
  barEndPixel?: { x: number; y: number };
  barLengthFeet?: number;
  confidence?: number;
}

const RENDER_SCALE = 3.33; // 240 DPI for legible scale bar text

const SCALE_BAR_PROMPT = `Find the graphic scale bar on this civil engineering plan sheet.
Look for a horizontal bar with tick marks and distance labels (e.g., 0, 20, 40, 60 feet),
typically located in the title block area (bottom-right corner) or along the bottom margin.
Also look for text notations like "1 INCH = 20 FEET", "SCALE: 1"=40'", or "1"=20'" near the scale bar.

Return a JSON object with these fields:
{
  "found": true,
  "notation": "1\\" = 20'",
  "feetPerInch": 20,
  "barStartPixel": { "x": 100, "y": 500 },
  "barEndPixel": { "x": 250, "y": 500 },
  "barLengthFeet": 40,
  "confidence": 0.95
}

If no scale bar is found, return: { "found": false, "confidence": 0 }

IMPORTANT:
- The pixel coordinates must be relative to the image dimensions you can see.
- barStartPixel is the LEFT endpoint (0 mark) of the bar.
- barEndPixel is the RIGHT endpoint (last mark) of the bar.
- barLengthFeet is the real-world distance the bar represents (e.g., if bar goes 0 to 40, barLengthFeet = 40).
- Report the actual pixel locations as accurately as possible — these will be used for scale calibration.`;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { extractionId, pages } = body as {
      extractionId: string;
      pages?: number[];
    };

    if (!extractionId) {
      return NextResponse.json(
        { error: "extractionId is required" },
        { status: 400 }
      );
    }

    // Load extraction with PDF data
    const extractionResult = await requireOwnedExtraction(extractionId, {
      pdfData: true,
      pageCount: true,
    });
    if (!extractionResult.ok) return extractionResult.response;
    const { record: extraction, session } = extractionResult;

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
        geminiModel: true,
        claudeModel: true,
        openaiModel: true,
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

    // Resolve model the same way /api/extract does: user preference → env
    // (Anthropic only) → ai-assist's own default. Previously this was never
    // set, so Auto-Scale silently ignored the user's configured model and
    // always used ai-assist.ts's DEFAULT_MODELS fallback — if that fallback
    // was invalid or inaccessible for the user's account, detection failed
    // outright while regular extraction (which does resolve the model) kept
    // working fine.
    const modelMap: Record<Provider, string | null | undefined> = {
      anthropic: user.claudeModel,
      openai: user.openaiModel,
      gemini: user.geminiModel,
    };
    const resolvedModel =
      modelMap[provider] || (provider === "anthropic" ? process.env.CLAUDE_MODEL : undefined) || undefined;

    const config: AIAssistConfig = { provider, apiKey, model: resolvedModel };

    // Determine which pages to search (default: 1-3, where scale bars usually live)
    const maxPage = extraction.pageCount || 10;
    const pagesToSearch = pages?.length
      ? pages.filter((p) => p >= 1 && p <= maxPage)
      : Array.from({ length: Math.min(3, maxPage) }, (_, i) => i + 1);

    const pdfBuffer = Buffer.from(extraction.pdfData);

    // Search each page, stop on first success
    for (const pageNum of pagesToSearch) {
      try {
        console.log(
          `[scale-bar] Searching page ${pageNum} at ${RENDER_SCALE}x (${Math.round(RENDER_SCALE * 72)} DPI)...`
        );

        const images = await renderPdfToImages(pdfBuffer, RENDER_SCALE, {
          start: pageNum,
          end: pageNum,
        });

        if (!images.length) continue;

        const jpegBase64 = images[0].toString("base64");

        const result = await analyzeImage<ScaleBarResult>(
          config,
          jpegBase64,
          SCALE_BAR_PROMPT,
          512
        );

        if (
          result.found &&
          result.barStartPixel &&
          result.barEndPixel &&
          result.barLengthFeet &&
          result.barLengthFeet > 0 &&
          (result.confidence ?? 0) >= 0.5
        ) {
          // Convert pixel coordinates to PDF-space (divide by render scale)
          const barStart = {
            x: result.barStartPixel.x / RENDER_SCALE,
            y: result.barStartPixel.y / RENDER_SCALE,
          };
          const barEnd = {
            x: result.barEndPixel.x / RENDER_SCALE,
            y: result.barEndPixel.y / RENDER_SCALE,
          };

          // Compute pixelsPerFoot in PDF-space
          const dx = barEnd.x - barStart.x;
          const dy = barEnd.y - barStart.y;
          const pdfPixelDistance = Math.sqrt(dx * dx + dy * dy);
          const pixelsPerFoot = pdfPixelDistance / result.barLengthFeet;

          console.log(
            `[scale-bar] Found on page ${pageNum}: ${result.notation} ` +
              `(${result.barLengthFeet} FT, ${pixelsPerFoot.toFixed(2)} px/ft, ` +
              `confidence ${((result.confidence ?? 0) * 100).toFixed(0)}%)`
          );

          return NextResponse.json({
            found: true,
            notation: result.notation,
            feetPerInch: result.feetPerInch,
            barStart,
            barEnd,
            barLengthFeet: result.barLengthFeet,
            page: pageNum,
            confidence: result.confidence,
            pixelsPerFoot,
          });
        }

        console.log(
          `[scale-bar] Page ${pageNum}: not found or low confidence`
        );
      } catch (err) {
        console.warn(
          `[scale-bar] Page ${pageNum} failed:`,
          err instanceof Error ? err.message : err
        );
        // Continue to next page
      }
    }

    return NextResponse.json({ found: false });
  } catch (error) {
    console.error("[scale-bar] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Scale bar detection failed",
      },
      { status: 500 }
    );
  }
}
