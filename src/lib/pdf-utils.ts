import { PDFDocument } from "pdf-lib";

const MAX_TEXT_LENGTH = 30_000;

/**
 * Anthropic's per-image vision limit is 5 MB of raw (pre-base64) bytes. We
 * target 4.0 MB to leave a full 1 MB safety margin — in practice some pages
 * with embedded raster content (aerial photos, shaded sections) come out
 * much larger than pure line drawings even after JPEG compression.
 */
const MAX_IMAGE_BYTES = 4.0 * 1024 * 1024;

/**
 * JPEG quality ladder for the per-page fit loop. Starts at 85 (already
 * visually lossless for line drawings), drops to 70, then 55 as a last resort
 * before we start shrinking the scale. Keeping the ladder at one scale is much
 * cheaper than re-rendering — re-encoding the same canvas is ~10× faster.
 */
const JPEG_QUALITY_LADDER = [85, 70, 55];

/**
 * Render PDF pages to JPEG images using pdfjs-dist (legacy Node build) + @napi-rs/canvas.
 *
 * Civil engineering drawings (mostly black lines on white background) compress
 * ~4× smaller as JPEG@92 than as PNG with no perceptible quality loss. This
 * keeps us under Anthropic's 5 MB per-image vision limit while still rendering
 * at ~180 DPI so profile-sheet station callouts are legible.
 *
 * If a specific page is still > MAX_IMAGE_BYTES after JPEG encoding (rare —
 * happens with shaded/photographic content or very large sheet sizes), the
 * function retries that page at progressively lower scales until it fits.
 *
 * Worker is explicitly disabled so pdfjs runs in the main Node thread —
 * this avoids the "fake worker failed" error when Next.js bundles server code.
 *
 * @param pdfBuffer Raw PDF bytes
 * @param scale Initial DPI scale (default 2.5 = 180 DPI). Per-page fallback may reduce this.
 * @param pageRange Optional { start, end } 1-indexed page range to render
 * @returns Array of JPEG buffers (consumers should set media_type: "image/jpeg")
 */
export async function renderPdfToImages(
  pdfBuffer: Buffer | Uint8Array,
  scale: number = 2.5,
  pageRange?: { start: number; end: number }
): Promise<Buffer[]> {
  // Dynamic ESM imports — pdfjs-dist v4 is ESM-only and can't be required().
  // Next.js's serverExternalPackages prevents bundling; these await import()s
  // load the packages at runtime from node_modules at the standard Node path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // @ts-expect-error — pdf.worker.mjs ships no .d.mts declarations
  const pdfjsWorker: any = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");

  // Register the worker on globalThis.pdfjsWorker so pdfjs uses it as the
  // main-thread message handler and skips the file-based worker lookup.
  // This is the official way to run pdfjs-dist in Node.js without a worker file.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).pdfjsWorker = pdfjsWorker;

  // Also set workerSrc to a dummy value — pdfjs still reads this property
  // but won't actually try to fetch the file since the main-thread handler is registered.
  pdfjs.GlobalWorkerOptions.workerSrc = "pdf.worker.mjs";

  // Node-compatible canvas factory for pdfjs
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const NodeCanvasFactory: any = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create(width: number, height: number): any {
      const canvas = createCanvas(width, height);
      return { canvas, context: canvas.getContext("2d") };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reset(canvasAndContext: any, width: number, height: number): void {
      canvasAndContext.canvas.width = width;
      canvasAndContext.canvas.height = height;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    destroy(canvasAndContext: any): void {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
      canvasAndContext.canvas = null;
      canvasAndContext.context = null;
    },
  };

  // pdfjs v4 strictly requires a plain Uint8Array — it rejects Node Buffer
  // (even though Buffer extends Uint8Array). `Uint8Array.from()` creates a
  // genuine new Uint8Array instance unrelated to Buffer.
  const data = Uint8Array.from(pdfBuffer);

  const loadingTask = pdfjs.getDocument({
    data,
    canvasFactory: NodeCanvasFactory,
    isEvalSupported: false,
    useWorkerFetch: false,
    disableFontFace: true,
  });

  const document = await loadingTask.promise;

  const images: Buffer[] = [];
  const numPages: number = document.numPages;
  const start = pageRange?.start ?? 1;
  const end = pageRange?.end ?? numPages;

  // Shrink factor applied each time we exhaust the quality ladder at a given scale
  const SHRINK = 0.75;
  // Minimum scale floor — below this, text on profile sheets becomes unreadable.
  // At scale 1.0, a D-size sheet renders at ~2592x1728 (~72 DPI).
  const MIN_SCALE = 1.0;
  // Hard cap on render attempts per page, just in case something pathological happens
  const MAX_RENDER_ATTEMPTS = 8;

  const mb = (n: number) => (n / 1024 / 1024).toFixed(2);

  for (
    let pageNumber = start;
    pageNumber <= Math.min(end, numPages);
    pageNumber++
  ) {
    let currentScale = scale;
    let jpegBuffer: Buffer | null = null;
    let lastCandidate: Buffer | null = null;
    let renderAttempts = 0;

    // Outer loop: one iteration per render. Each render is followed by the
    // JPEG quality ladder (cheap re-encodes of the same canvas). Only shrink
    // the scale if NONE of the qualities produced a small enough image.
    // Get a FRESH page object for each attempt to avoid "Cannot use the same
    // canvas during multiple render() operations" errors from pdfjs.
    while (jpegBuffer === null && renderAttempts < MAX_RENDER_ATTEMPTS) {
      renderAttempts++;
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: currentScale });
      const canvasAndContext = NodeCanvasFactory.create(
        viewport.width,
        viewport.height
      );

      const renderTask = page.render({
        canvasContext: canvasAndContext.context,
        viewport,
        canvasFactory: NodeCanvasFactory,
      });
      await renderTask.promise;

      // ── Contrast enhancement for civil engineering line drawings ──
      // Darken dark pixels (text, lines) and whiten light pixels (background).
      // Makes thin 8-10pt callout labels pop against crowded profile grids.
      // Especially helps with SSMH elevation readings and small fitting labels.
      // Adds ~50-100ms per page, zero API cost, slightly better JPEG compression.
      try {
        const ctx = canvasAndContext.context;
        const imgData = ctx.getImageData(0, 0, viewport.width, viewport.height);
        const pixels = imgData.data;

        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;

          if (lum < 160) {
            // Dark pixel (text, lines) — darken by 30% for stronger contrast
            pixels[i] = Math.round(r * 0.7);
            pixels[i + 1] = Math.round(g * 0.7);
            pixels[i + 2] = Math.round(b * 0.7);
          } else if (lum > 200) {
            // Light pixel (background) — push to pure white
            pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
          }
          // Mid-tones (160-200) left untouched to preserve color utility markings
        }

        ctx.putImageData(imgData, 0, 0);
      } catch {
        // If getImageData fails (shouldn't on @napi-rs/canvas), skip enhancement
      }

      // Try each quality level; re-encoding the same canvas is very cheap
      // compared to re-rendering.
      let acceptedAtQuality: number | null = null;
      for (const quality of JPEG_QUALITY_LADDER) {
        const candidate: Buffer = canvasAndContext.canvas.toBuffer(
          "image/jpeg",
          quality
        );
        lastCandidate = candidate;
        if (candidate.length <= MAX_IMAGE_BYTES) {
          jpegBuffer = candidate;
          acceptedAtQuality = quality;
          break;
        }
      }

      NodeCanvasFactory.destroy(canvasAndContext);

      if (jpegBuffer !== null) {
        if (renderAttempts > 1 || acceptedAtQuality !== JPEG_QUALITY_LADDER[0]) {
          console.log(
            `[pdf-utils] page ${pageNumber} accepted at scale ${currentScale.toFixed(2)} quality ${acceptedAtQuality} — ${mb(jpegBuffer.length)} MB (attempt ${renderAttempts})`
          );
        }
        break;
      }

      // All qualities exhausted at this scale — log and shrink.
      const lastSize = lastCandidate ? mb(lastCandidate.length) : "?";
      if (currentScale <= MIN_SCALE) {
        // We're already at the floor and even quality 55 couldn't fit it.
        // Accept the smallest candidate we have and let the caller fail
        // visibly if it's still over the cap — better than an infinite loop.
        console.error(
          `[pdf-utils] page ${pageNumber} could not fit under ${mb(MAX_IMAGE_BYTES)} MB at scale ${MIN_SCALE} even at lowest quality (${lastSize} MB). Accepting oversized image.`
        );
        jpegBuffer = lastCandidate;
        break;
      }

      console.warn(
        `[pdf-utils] page ${pageNumber} too large at scale ${currentScale.toFixed(2)} (smallest: ${lastSize} MB > ${mb(MAX_IMAGE_BYTES)} MB); shrinking`
      );
      currentScale = Math.max(currentScale * SHRINK, MIN_SCALE);
    }

    if (jpegBuffer === null) {
      throw new Error(
        `Failed to render page ${pageNumber} after ${MAX_RENDER_ATTEMPTS} attempts`
      );
    }

    images.push(jpegBuffer);
    // page.cleanup() is handled inside the while loop — each fresh page object
    // is cleaned up by pdfjs when the next getPage() call reuses the slot.
  }

  await document.cleanup();
  await document.destroy();

  return images;
}

/**
 * Extract text items with (x, y) positions from the PDF's text layer using
 * pdfjs-dist's getTextContent(). Unlike extractPdfText() which returns a
 * flat string, this preserves the spatial position and font size of each
 * text span — so the prompt can include coordinate-annotated callouts like:
 *
 *   Page 3 (1234, 567) size=8pt: "1-18X18 WYE"
 *
 * When Claude sees BOTH the image AND this explicit text layer, it can
 * cross-reference what it sees visually with confirmed text. This is
 * especially valuable for small 8-10pt callout labels that native PDF
 * mode's ~72 DPI rendering makes hard to read visually.
 *
 * Returns empty arrays for pages where text is fully outlined (converted
 * to geometry). Zero additional API cost — runs locally in ~100ms/page.
 *
 * @param pdfBuffer Raw PDF bytes
 * @returns Formatted text block ready to append to the extraction prompt
 */
export async function extractTextWithPositions(
  pdfBuffer: Buffer | Uint8Array
): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // @ts-expect-error — pdf.worker.mjs ships no .d.mts declarations
    const pdfjsWorker: any = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const { createCanvas } = await import("@napi-rs/canvas");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).pdfjsWorker = pdfjsWorker;
    pdfjs.GlobalWorkerOptions.workerSrc = "pdf.worker.mjs";

    // Minimal canvas factory — pdfjs requires it even for text-only extraction
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const NodeCanvasFactory: any = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create(w: number, h: number): any {
        const c = createCanvas(w, h);
        return { canvas: c, context: c.getContext("2d") };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reset(cc: any, w: number, h: number): void {
        cc.canvas.width = w;
        cc.canvas.height = h;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      destroy(cc: any): void {
        cc.canvas.width = 0;
        cc.canvas.height = 0;
      },
    };

    const data = Uint8Array.from(pdfBuffer);
    const doc = await pdfjs.getDocument({
      data,
      canvasFactory: NodeCanvasFactory,
      isEvalSupported: false,
      useWorkerFetch: false,
      disableFontFace: true,
    }).promise;

    const lines: string[] = [];
    let totalItems = 0;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageItems: string[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const item of textContent.items as any[]) {
        if (typeof item.str !== "string" || item.str.trim().length === 0) continue;

        const t = item.transform;
        const x = Math.round(t[4]);
        const y = Math.round(t[5]);
        const fontSize = Math.round(Math.hypot(t[0], t[1]));
        const text = item.str.trim();

        // Skip very small items (< 4pt) — usually garbage chars or markers
        if (fontSize < 4) continue;

        pageItems.push(`  (${x},${y}) ${fontSize}pt: "${text}"`);
        totalItems++;
      }

      if (pageItems.length > 0) {
        lines.push(`Page ${pageNum} (${pageItems.length} text items):`);
        lines.push(...pageItems);
      }

      page.cleanup();
    }

    await doc.cleanup();
    await doc.destroy();

    if (totalItems === 0) {
      return ""; // No text layer — don't clutter the prompt
    }

    console.log(
      `[pdf-utils] extractTextWithPositions: ${totalItems} text items across ${doc.numPages} pages`
    );

    // Cap at ~30000 chars to include profile sheet text data
    let result = lines.join("\n");
    if (result.length > 15000) {
      result = result.slice(0, 30000) + "\n[... truncated]";
    }

    return result;
  } catch (err) {
    console.warn(
      "[pdf-utils] extractTextWithPositions failed:",
      err instanceof Error ? err.message : err
    );
    return "";
  }
}

/**
 * Extract text content from a PDF using pdf-parse (Mozilla pdf.js).
 * Returns page-delimited text, truncated to MAX_TEXT_LENGTH characters.
 * Falls back to a basic metadata string if text extraction fails.
 * Note: pdf-parse is lazy-imported to avoid its test-file loading on require().
 */
export async function extractPdfText(pdfBase64: string): Promise<string> {
  const buffer = Buffer.from(pdfBase64, "base64");
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse");
    const data = await pdfParse(buffer);
    const text = (data.text || "").trim();
    if (!text) {
      return `[PDF Document: ${data.numpages} pages. No embedded text found — this may be a scanned/image-only PDF.]`;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return text.slice(0, MAX_TEXT_LENGTH) + `\n[... truncated, ${data.numpages} pages total]`;
    }
    return text;
  } catch {
    // Fall back to basic metadata
    try {
      const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
      return `[PDF Document: ${doc.getPageCount()} pages. Text extraction failed — analyze visual content.]`;
    } catch {
      return "[PDF Document: Text extraction failed.]";
    }
  }
}

/**
 * Validate a PDF buffer by attempting to re-load it with pdf-lib.
 * Returns true if the PDF is structurally valid, false otherwise.
 * Used to catch corruption introduced by pdf-lib's page copying.
 */
export async function validatePdfBuffer(
  buffer: Uint8Array
): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    return doc.getPageCount() > 0;
  } catch {
    return false;
  }
}

/**
 * Get the number of pages in a PDF buffer.
 */
export async function getPdfPageCount(buffer: Buffer): Promise<number> {
  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return pdfDoc.getPageCount();
}

/**
 * Extract a range of pages from a PDF buffer into a new PDF buffer.
 * Pages are 0-indexed internally but the public API uses 1-indexed pages.
 * @param buffer - The full PDF buffer
 * @param startPage - 1-indexed start page (inclusive)
 * @param endPage - 1-indexed end page (inclusive)
 */
export async function extractPages(
  buffer: Buffer,
  startPage: number,
  endPage: number
): Promise<Buffer> {
  const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const totalPages = srcDoc.getPageCount();

  // Clamp to valid range
  const start = Math.max(1, startPage) - 1; // convert to 0-indexed
  const end = Math.min(totalPages, endPage) - 1; // convert to 0-indexed

  if (start > end) {
    throw new Error(
      `Invalid page range: ${startPage}-${endPage} (PDF has ${totalPages} pages)`
    );
  }

  const newDoc = await PDFDocument.create();
  const pageIndices = Array.from(
    { length: end - start + 1 },
    (_, i) => start + i
  );

  const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
  copiedPages.forEach((page) => newDoc.addPage(page));

  const pdfBytes = await newDoc.save();
  const result = Buffer.from(pdfBytes);

  // Validate the extracted PDF is structurally sound
  const isValid = await validatePdfBuffer(result);
  if (!isValid) {
    console.warn(
      `[pdf-utils] extractPages(${startPage}-${endPage}) produced invalid PDF ` +
        `(${result.length} bytes from ${buffer.length} byte source)`
    );
    throw new Error(
      `PDF page extraction produced corrupted output for pages ${startPage}-${endPage}`
    );
  }

  return result;
}

/**
 * Extract specific page ranges from a PDF.
 * @param buffer - The full PDF buffer
 * @param ranges - Array of [start, end] tuples (1-indexed, inclusive)
 */
export async function extractPageRanges(
  buffer: Buffer,
  ranges: Array<[number, number]>
): Promise<Buffer> {
  // Strategy: try pdf-lib's copyPages first (fast, preserves vector geometry
  // and text perfectly). If the extraction produces a corrupt PDF OR throws,
  // fall back to a pdfjs-based rebuild that rasterizes the chosen pages to
  // images and wraps them in a new PDF. Rasterization is lossy but works on
  // civil plan PDFs with complex xobject/font graphs that pdf-lib can't
  // correctly copy.

  const rangeStr = ranges.map(([s, e]) => `${s}-${e}`).join(", ");
  let pdfLibError: unknown = null;

  // ── Primary: pdf-lib copyPages ──
  try {
    const srcDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    const newDoc = await PDFDocument.create();

    // Collect all page indices from ranges
    const pageIndices: number[] = [];
    for (const [start, end] of ranges) {
      const s = Math.max(1, start) - 1; // 0-indexed
      const e = Math.min(totalPages, end) - 1; // 0-indexed
      for (let i = s; i <= e; i++) {
        if (!pageIndices.includes(i)) {
          pageIndices.push(i);
        }
      }
    }

    pageIndices.sort((a, b) => a - b);

    if (pageIndices.length === 0) {
      throw new Error("No valid pages in the specified ranges");
    }

    const copiedPages = await newDoc.copyPages(srcDoc, pageIndices);
    copiedPages.forEach((page) => newDoc.addPage(page));

    const pdfBytes = await newDoc.save();
    const result = Buffer.from(pdfBytes);

    // Validate the extracted PDF is structurally sound
    const isValid = await validatePdfBuffer(result);
    if (isValid) {
      console.log(
        `[extractPageRanges] pdf-lib path succeeded for ranges [${rangeStr}] ` +
          `(${(result.length / 1024 / 1024).toFixed(1)} MB)`
      );
      return result;
    }
    console.warn(
      `[extractPageRanges] pdf-lib produced invalid PDF for [${rangeStr}] ` +
        `(${result.length} bytes from ${buffer.length} byte source). Trying pdfjs fallback...`
    );
    pdfLibError = new Error("pdf-lib produced corrupted output");
  } catch (err) {
    pdfLibError = err;
    console.warn(
      `[extractPageRanges] pdf-lib threw for [${rangeStr}]: ` +
        `${err instanceof Error ? err.message : String(err)}. Trying pdfjs fallback...`
    );
  }

  // ── Fallback: pdfjs rasterize + rebuild ──
  // For complex civil plan PDFs where pdf-lib can't copy pages cleanly, we
  // render each requested page to a JPEG via pdfjs-dist and embed the JPEGs
  // as single-page images in a new PDF. The AI extraction pipeline operates
  // on the visual content anyway, so losing text-layer fidelity is acceptable
  // in exchange for actually getting the pages the user asked for.
  try {
    // Flatten ranges to a sorted list of 1-indexed page numbers
    const pages = new Set<number>();
    for (const [start, end] of ranges) {
      for (let p = start; p <= end; p++) pages.add(p);
    }
    const pageList = Array.from(pages).sort((a, b) => a - b);

    if (pageList.length === 0) {
      throw new Error("No valid pages in the specified ranges");
    }

    // Render the selected pages at conservative DPI. Fallback path must be
    // aggressive about size — the output needs to chunk into ≤28 MB base64
    // chunks for Anthropic. Starting at scale 1.5 (≈108 DPI) keeps each JPEG
    // around 2-3 MB even on dense civil sheets, which leaves ample headroom
    // for chunk assembly. Anthropic's vision can still read 10-12pt callouts
    // at this density; we accept a small loss vs scale 2.5 to guarantee the
    // fallback actually ships to the API.
    const FALLBACK_SCALE = 1.5;
    // Max bytes per rendered page in the fallback. 3 MB means a single-page
    // chunk is ~4 MB base64 — well under the chunker's 28 MB budget. If any
    // page exceeds this, we re-render it at progressively lower scale.
    const FALLBACK_PAGE_MAX_BYTES = 3 * 1024 * 1024;

    const images: Buffer[] = [];
    for (const p of pageList) {
      let currentScale = FALLBACK_SCALE;
      let rendered: Buffer[] = [];
      // Try up to 3 scale steps down to ensure each page fits.
      for (let attempt = 0; attempt < 3; attempt++) {
        rendered = await renderPdfToImages(buffer, currentScale, { start: p, end: p });
        if (rendered.length === 0) {
          throw new Error(`Failed to render page ${p}`);
        }
        if (rendered[0].length <= FALLBACK_PAGE_MAX_BYTES) break;
        // Too big — cut scale in half and retry (1.5 → 0.75 → 0.375)
        console.warn(
          `[extractPageRanges] Fallback page ${p} rendered ${(rendered[0].length / 1024 / 1024).toFixed(1)} MB at scale ${currentScale} — re-rendering smaller`
        );
        currentScale = currentScale * 0.5;
      }
      images.push(rendered[0]);
    }

    // Build new PDF with one page per rendered image
    const newDoc = await PDFDocument.create();
    for (const imgBytes of images) {
      const jpg = await newDoc.embedJpg(imgBytes);
      const page = newDoc.addPage([jpg.width, jpg.height]);
      page.drawImage(jpg, { x: 0, y: 0, width: jpg.width, height: jpg.height });
    }

    const outBytes = await newDoc.save();
    const result = Buffer.from(outBytes);

    const isValid = await validatePdfBuffer(result);
    if (!isValid) {
      throw new Error("pdfjs-rebuilt PDF failed validation");
    }

    console.log(
      `[extractPageRanges] pdfjs fallback succeeded for [${rangeStr}] ` +
        `(${pageList.length} pages rendered, ${(result.length / 1024 / 1024).toFixed(1)} MB). ` +
        `Text-layer fidelity is lost in this path but visual content is preserved.`
    );
    return result;
  } catch (fallbackErr) {
    const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    const originalMsg = pdfLibError instanceof Error ? pdfLibError.message : String(pdfLibError);
    throw new Error(
      `Page extraction failed via both pdf-lib (${originalMsg}) and pdfjs fallback (${msg}) for ranges [${rangeStr}]`
    );
  }
}

/**
 * The max base64 size (in bytes) for a single API request.
 * 20MB base64 keeps requests well under Anthropic's ~32MB and OpenAI's ~25MB limits.
 */
const DEFAULT_MAX_BASE64_SIZE = 20 * 1024 * 1024;

/**
 * Split a PDF into chunks where each chunk's base64 size is under maxBase64Size.
 * Returns an array of objects with the PDF buffer and page range label.
 */
/**
 * Classify a page's utility system by scanning its text content for sheet
 * number patterns. Civil plan sets use standardized sheet prefixes:
 *   C-1/C-2: Site/grading/demo → "general"
 *   C-3/C-4/C-5: May be water, storm, or grading depending on the firm
 *   C-6/C-7/C-8/C-9: Usually water, sewer, storm utility plans/profiles
 *   C-10+: Details, standards, notes
 *
 * We also look for keywords like "WATER", "SEWER", "STORM", "PROFILE" in
 * the page text to classify more accurately.
 */
/**
 * Extract plain text from each page of a PDF using pdfjs-dist.
 * Returns an array of strings, one per page (padded with "" for pages
 * that can't be read). Used for page-by-page classification in
 * splitPdfForClaude — pdf-parse concatenates all pages and can fail on
 * some civil-plan PDFs (outlined text, embedded fonts), while pdfjs is
 * more resilient.
 */
async function extractPageTexts(
  buffer: Buffer | Uint8Array
): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const numPages: number = doc.numPages;
  const results: string[] = new Array(numPages).fill("");

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    try {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();
      // Concatenate all text items on this page, separated by spaces
      const items: Array<{ str: string }> = textContent.items || [];
      const pageText = items.map((item) => item.str || "").join(" ").trim();
      results[pageNum - 1] = pageText;
    } catch {
      // Leave empty for pages that fail — they'll classify as "general"
      results[pageNum - 1] = "";
    }
  }

  try {
    await doc.destroy();
  } catch {
    // ignore
  }

  return results;
}

function classifyPageSystem(
  pageText: string
): "water" | "sewer" | "storm" | "general" {
  const upper = pageText.toUpperCase();

  // Check for profile indicators first — profiles are the most important
  // to group correctly with their plan views
  const hasProfile =
    /\bPROFILE\b/.test(upper) ||
    /\bSTA\s+\d+\+/.test(upper) || // station markers
    /\bRIM\b.*\bFL\b/.test(upper); // RIM/FL elevations

  // Check for system keywords.
  // NOTE ON REGEX DESIGN: the classifier returns a specific system only when
  // EXACTLY ONE system matches (see exclusive-match logic below). That means
  // keywords which co-occur on multiple system sheets (e.g. "GATE VALVE"
  // appears on both water plans and storm drain note sheets) will cause
  // pages to fall through to "general". Keep these regexes TIGHT — prefer
  // plan-title keywords and system-exclusive markers over generic component
  // names that appear across systems.
  const hasWater =
    // Plan titles — include "UTILITY", "SYSTEM", "DISTRIBUTION" to catch
    // "WATER UTILITY PLAN", "WATER SYSTEM PLAN", etc. which previous regex
    // missed. These phrases are unique to water plan sheets.
    /\bWATER\s+(PLAN|LINE|MAIN|PROFILE|SERVICE|UTILITY|SYSTEM|DISTRIBUTION)\b/.test(upper) ||
    /\b(DOMESTIC|POTABLE)\s+WATER\b/.test(upper) ||
    // Water-exclusive pipe specs
    /\bDR[- ]?14\b|\bDR[- ]?18\b|\bC[- ]?9[0-9]{2}\b/.test(upper) ||
    // Combined water/sewer plan sheets
    /\bWATER\s+(AND|&)\s+SEWER\b/.test(upper);

  const hasSewer =
    /\bSEWER\s+(PLAN|LINE|MAIN|PROFILE|LATERAL|UTILITY|SYSTEM)\b/.test(upper) ||
    /\bSANITARY(\s+SEWER)?\s+(PLAN|PROFILE|LINE|MAIN|LATERAL)\b/.test(upper) ||
    /\bSS[-\s]?\d+\s+PROFILE\b/.test(upper) ||
    /\bSSMH\b/.test(upper) ||
    /\bSDR\s*2[6-9]\b|\bSDR\s*3[5-6]\b/.test(upper) ||
    /\bWASTEWATER\s+(PLAN|LINE|MAIN|PROFILE)\b/.test(upper);

  const hasStorm =
    /\bSTORM\s+(DRAIN|PLAN|LINE|PROFILE|SEWER|UTILITY|SYSTEM)\b/.test(upper) ||
    /\bSTM\s+LINE\b/.test(upper) ||
    /\bCURB\s+INLET\b/.test(upper) ||
    /\bHDPE\b/.test(upper) ||
    /\bRCP\b/.test(upper) ||
    /\bHEADWALL\b/.test(upper);

  // If profile + a system keyword, strongly classify
  if (hasProfile && hasSewer) return "sewer";
  if (hasProfile && hasStorm) return "storm";
  if (hasProfile && hasWater) return "water";

  // Non-profile pages: use keyword matching
  if (hasSewer && !hasStorm && !hasWater) return "sewer";
  if (hasStorm && !hasSewer && !hasWater) return "storm";
  if (hasWater && !hasSewer && !hasStorm) return "water";

  // Water & Sewer combined sheets (common) — group with sewer since sewer
  // profiles are the ones most commonly lost in chunking
  if (hasWater && hasSewer) return "sewer";

  return "general";
}

export async function splitPdfForClaude(
  buffer: Buffer,
  maxBase64Size: number = DEFAULT_MAX_BASE64_SIZE
): Promise<Array<{ buffer: Buffer; label: string; startPage: number; endPage: number }>> {
  const totalPages = await getPdfPageCount(buffer);

  // Check if the whole PDF fits — no chunking needed
  const totalBase64Size = Math.ceil(buffer.length * 1.34);
  if (totalBase64Size <= maxBase64Size) {
    return [
      {
        buffer,
        label: `Pages 1-${totalPages}`,
        startPage: 1,
        endPage: totalPages,
      },
    ];
  }

  // If single page and still too large, we can't split further
  if (totalPages === 1) {
    throw new Error(
      "This PDF has a single page that exceeds the maximum size limit. " +
        "Please try reducing the file size or image resolution."
    );
  }

  // ── Sequential chunking ──
  // Smart (classification-based) chunking was tried and caused repeated
  // regressions — pages with cross-system keywords fell to "general" and
  // the AI under-extracted, producing placeholders like "MEASURE MANUALLY:
  // see civil sheets" while other chunks silently returned 0 items.
  //
  // Sequential chunking is simpler and predictable: every page ends up in
  // exactly one chunk in page order. The AI sees chunks of consecutive
  // pages, which matches how plan sets are organized (plan view + profile
  // adjacent, details grouped). This is what the committed baseline used
  // before smart chunking was ever tried.
  //
  // Smart-chunking keywords and classifier functions are retained below in
  // case they're needed for other features, but splitPdfForClaude no longer
  // calls them.

  console.log(
    `[split] PDF is ${(buffer.length / 1024 / 1024).toFixed(1)} MB (${totalPages} pages). Chunking sequentially.`
  );

  const maxRawSize = maxBase64Size / 1.34;
  const avgPageSize = buffer.length / totalPages;
  const chunks: Array<{
    buffer: Buffer;
    label: string;
    startPage: number;
    endPage: number;
  }> = [];

  // Estimate pages per chunk from average page size, minus 20% safety margin
  let pagesPerChunk = Math.max(1, Math.floor(maxRawSize / avgPageSize));
  pagesPerChunk = Math.max(1, Math.floor(pagesPerChunk * 0.8));

  let currentStart = 1;
  while (currentStart <= totalPages) {
    let currentEnd = Math.min(currentStart + pagesPerChunk - 1, totalPages);

    // Extract the chunk and verify it fits under maxBase64Size
    let chunkBuffer = await extractPages(buffer, currentStart, currentEnd);
    let chunkBase64Size = Math.ceil(chunkBuffer.length * 1.34);

    // If chunk is too large, trim one page at a time until it fits
    while (chunkBase64Size > maxBase64Size && currentEnd > currentStart) {
      currentEnd--;
      chunkBuffer = await extractPages(buffer, currentStart, currentEnd);
      chunkBase64Size = Math.ceil(chunkBuffer.length * 1.34);
    }

    // If a single page alone is still too large, include it anyway and warn
    if (chunkBase64Size > maxBase64Size && currentEnd === currentStart) {
      console.warn(
        `[split] Page ${currentStart} alone is ${(chunkBase64Size / 1024 / 1024).toFixed(1)}MB base64 — exceeds limit. Including anyway.`
      );
    }

    chunks.push({
      buffer: chunkBuffer,
      label: `Pages ${currentStart}-${currentEnd}`,
      startPage: currentStart,
      endPage: currentEnd,
    });
    console.log(
      `[split] Chunk: pages ${currentStart}-${currentEnd} (${currentEnd - currentStart + 1} pages, ${(chunkBuffer.length / 1024 / 1024).toFixed(1)} MB)`
    );

    currentStart = currentEnd + 1;
  }

  console.log(`[split] Total: ${chunks.length} chunks from ${totalPages} pages`);
  return chunks;
}

/**
 * Parse a page range string like "1-10, 15-20, 25" into an array of [start, end] tuples.
 */
export function parsePageRanges(
  rangeStr: string,
  totalPages: number
): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  const parts = rangeStr.split(",").map((s) => s.trim()).filter(Boolean);

  for (const part of parts) {
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-").map((s) => s.trim());
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid page range: "${part}"`);
      }
      if (start < 1 || end < 1) {
        throw new Error(`Page numbers must be positive: "${part}"`);
      }
      if (start > end) {
        throw new Error(`Invalid range (start > end): "${part}"`);
      }
      if (start > totalPages || end > totalPages) {
        throw new Error(
          `Page range "${part}" exceeds total pages (${totalPages})`
        );
      }

      ranges.push([start, end]);
    } else {
      const page = parseInt(part, 10);
      if (isNaN(page)) {
        throw new Error(`Invalid page number: "${part}"`);
      }
      if (page < 1 || page > totalPages) {
        throw new Error(
          `Page ${page} is out of range (1-${totalPages})`
        );
      }
      ranges.push([page, page]);
    }
  }

  if (ranges.length === 0) {
    throw new Error("No valid page ranges specified");
  }

  return ranges;
}
