import { PDFDocument } from "pdf-lib";

const MAX_TEXT_LENGTH = 30_000;

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
  if (!isValid) {
    const rangeStr = ranges.map(([s, e]) => `${s}-${e}`).join(", ");
    console.warn(
      `[pdf-utils] extractPageRanges([${rangeStr}]) produced invalid PDF ` +
        `(${result.length} bytes from ${buffer.length} byte source)`
    );
    throw new Error(
      `PDF page extraction produced corrupted output for ranges [${rangeStr}]`
    );
  }

  return result;
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
export async function splitPdfForClaude(
  buffer: Buffer,
  maxBase64Size: number = DEFAULT_MAX_BASE64_SIZE
): Promise<Array<{ buffer: Buffer; label: string; startPage: number; endPage: number }>> {
  const totalPages = await getPdfPageCount(buffer);

  // Check if the whole PDF fits
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

  // Estimate pages per chunk based on average page size
  const avgPageSize = buffer.length / totalPages;
  const maxRawSize = maxBase64Size / 1.34; // convert base64 limit back to raw bytes
  let pagesPerChunk = Math.max(1, Math.floor(maxRawSize / avgPageSize));

  // Safety margin: reduce by 20% to account for PDF overhead and uneven page sizes
  pagesPerChunk = Math.max(1, Math.floor(pagesPerChunk * 0.8));

  const chunks: Array<{
    buffer: Buffer;
    label: string;
    startPage: number;
    endPage: number;
  }> = [];

  let currentStart = 1;

  while (currentStart <= totalPages) {
    let currentEnd = Math.min(currentStart + pagesPerChunk - 1, totalPages);

    // Extract the chunk
    let chunkBuffer = await extractPages(buffer, currentStart, currentEnd);
    let chunkBase64Size = Math.ceil(chunkBuffer.length * 1.34);

    // If chunk is still too large, reduce pages until it fits
    while (chunkBase64Size > maxBase64Size && currentEnd > currentStart) {
      currentEnd--;
      chunkBuffer = await extractPages(buffer, currentStart, currentEnd);
      chunkBase64Size = Math.ceil(chunkBuffer.length * 1.34);
    }

    // If a single page is still too large, include it anyway with a warning
    // (Claude might still handle it, or we'll get an error we can report)
    if (chunkBase64Size > maxBase64Size && currentEnd === currentStart) {
      console.warn(
        `Page ${currentStart} alone is ${(chunkBase64Size / 1024 / 1024).toFixed(1)}MB base64, which exceeds the limit. Including anyway.`
      );
    }

    chunks.push({
      buffer: chunkBuffer,
      label: `Pages ${currentStart}-${currentEnd}`,
      startPage: currentStart,
      endPage: currentEnd,
    });

    currentStart = currentEnd + 1;
  }

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
