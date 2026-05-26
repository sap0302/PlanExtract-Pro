"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// pdfjs-dist types are NOT imported to avoid SSR DOMMatrix errors.
// All pdfjs objects are typed as `any` — the module is only loaded at runtime in the browser.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pdfjsModule: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPdfjs(): Promise<any> {
  if (pdfjsModule) return pdfjsModule;
  const lib = await import("pdfjs-dist");
  // Use local worker copy (public/pdf.worker.min.mjs) to avoid CDN network errors
  lib.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs`;
  pdfjsModule = lib;
  return lib;
}

interface PdfViewerProps {
  pdfUrl: string;
  currentPage: number;
  onPageChange: (page: number) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  panOffset: { x: number; y: number };
  onPanOffsetChange: (offset: { x: number; y: number }) => void;
  onCanvasReady?: (canvas: HTMLCanvasElement, pdfWidth: number, pdfHeight: number) => void;
  activeTool: string;
  isSpaceDown: boolean;
  renderOverlay?: (width: number, height: number) => React.ReactNode;
  /**
   * Optional list of text snippets to find and highlight on the rendered page.
   * Used by the "View on PDF" feature — passes evidence excerpts from an Item
   * (e.g. "STA 058.01", "INSTALL: 1 - 8X8 TEE") and the viewer draws yellow
   * highlight boxes over matching text in the PDF text layer. Free + instant
   * (no API call, no AI involvement). Matches are case-insensitive.
   */
  textHighlights?: string[];
}

/**
 * A text-layer match resolved to base-viewport (scale=1) pixel coordinates.
 * The viewer scales to current zoom in CSS so we don't need to recompute on
 * zoom change.
 */
interface TextMatch {
  x: number;       // top-left X in scale-1 pixels
  y: number;       // top-left Y in scale-1 pixels (canvas coords, top-down)
  width: number;
  height: number;
  text: string;    // matched span (for tooltip)
}

export function PdfViewer({
  pdfUrl,
  currentPage,
  onPageChange,
  zoom,
  onZoomChange,
  panOffset,
  onPanOffsetChange,
  onCanvasReady,
  activeTool,
  isSpaceDown,
  renderOverlay,
  textHighlights,
}: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<any | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [pageInput, setPageInput] = useState(String(currentPage));
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const [overlayDims, setOverlayDims] = useState({ width: 0, height: 0 });
  const [loadError, setLoadError] = useState<{ title: string; detail: string } | null>(null);
  // Text-search highlights for the current page, in base (scale=1) viewport pixels.
  const [textMatches, setTextMatches] = useState<TextMatch[]>([]);

  // Load PDF document (dynamic import to avoid SSR DOMMatrix error)
  useEffect(() => {
    let cancelled = false;
    const loadPdf = async () => {
      try {
        setLoadError(null);
        // Preflight fetch so we can detect our API's structured 404 responses
        // (e.g. "PDF not stored for this extraction") and show a specific,
        // actionable message instead of pdfjs's generic parse error.
        // credentials: "include" guarantees the NextAuth session cookie rides
        // along in all browser SameSite configurations.
        const preflight = await fetch(pdfUrl, { credentials: "include" });
        if (!preflight.ok) {
          let reason = "unknown";
          let fileName: string | undefined;
          try {
            const body = (await preflight.clone().json()) as {
              reason?: string;
              fileName?: string;
            };
            reason = body.reason || "unknown";
            fileName = body.fileName;
          } catch {
            // not json
          }
          if (cancelled) return;
          if (preflight.status === 401) {
            setLoadError({
              title: "Not signed in",
              detail: "Your session expired. Return to the main window and sign back in, then reopen the measure window.",
            });
          } else if (reason === "not_stored") {
            setLoadError({
              title: "PDF not cached for this extraction",
              detail: `The file ${fileName ? `"${fileName}" ` : ""}was not saved to the database (this can happen on very large files). Re-upload the PDF from the extraction detail page to enable measurement.`,
            });
          } else if (preflight.status === 404) {
            setLoadError({
              title: "Extraction not found",
              detail: "This extraction no longer exists or doesn't belong to your account.",
            });
          } else {
            setLoadError({
              title: `Failed to load PDF (HTTP ${preflight.status})`,
              detail: "The server couldn't deliver the cached PDF for this extraction. Try refreshing this tab.",
            });
          }
          return;
        }

        // Read the PDF body from the SAME preflight response — avoids
        // double-fetching a 100+ MB file and sidesteps pdfjs's internal XHR
        // (which has been failing with "network error" on large same-origin
        // PDFs served from the Next.js API, likely due to range-request
        // handling or the OneDrive-synced SQLite response latency). Loading
        // the whole PDF into an ArrayBuffer costs RAM proportional to file
        // size, but that's fine up to a few hundred MB in a browser tab.
        const arrayBuffer = await preflight.arrayBuffer();
        if (cancelled) return;

        const pdfjsLib = await getPdfjs();
        const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        if (!cancelled) {
          setPdfDoc(doc);
          setPageCount(doc.numPages);
        }
      } catch (err) {
        console.error("Failed to load PDF:", err);
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setLoadError({
            title: "Failed to load PDF",
            detail: message,
          });
        }
      }
    };
    loadPdf();
    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  // Track active render task so we can cancel it on re-render
  const renderTaskRef = useRef<any | null>(null);

  // Render current page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let cancelled = false;

    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
      renderTaskRef.current = null;
    }

    const renderPage = async () => {
      setRendering(true);
      try {
        const page = await pdfDoc.getPage(currentPage);
        const viewport = page.getViewport({ scale: zoom });
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d")!;

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const task = page.render({ canvasContext: ctx, viewport } as any);
        renderTaskRef.current = task;
        await task.promise;
        renderTaskRef.current = null;

        if (!cancelled && onCanvasReady) {
          const baseViewport = page.getViewport({ scale: 1 });
          onCanvasReady(canvas, baseViewport.width, baseViewport.height);
        }
      } catch (err) {
        // Check for cancelled render (name-based check since pdfjsLib may not be loaded)
        if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "RenderingCancelledException") return;
        if (!cancelled) console.error("Failed to render page:", err);
      } finally {
        if (!cancelled) setRendering(false);
      }
    };

    renderPage();
    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [pdfDoc, currentPage, zoom, onCanvasReady]);

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  // Find textHighlights on the current page using pdfjs's text content API.
  // Runs whenever the page or highlight tokens change. Output is cached in
  // base-viewport (scale=1) pixel coords; CSS multiplies by current zoom so
  // panning / zooming doesn't require re-querying pdfjs.
  useEffect(() => {
    let cancelled = false;
    if (!pdfDoc) {
      setTextMatches([]);
      return;
    }
    if (!textHighlights || textHighlights.length === 0) {
      setTextMatches([]);
      return;
    }

    const findMatches = async () => {
      try {
        const page = await pdfDoc.getPage(currentPage);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        if (cancelled) return;

        const pdfjsLib = await getPdfjs();
        const tokens = textHighlights
          .map((t) => t.toLowerCase().trim())
          .filter((t) => t.length >= 3);

        const results: TextMatch[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const item of content.items as any[]) {
          if (!item || typeof item.str !== "string" || !item.str) continue;
          const lower = item.str.toLowerCase();
          // Match if the text item contains ANY token (case-insensitive
          // substring match — engineers often have callouts split or padded,
          // exact-equality would miss too much).
          const hit = tokens.some((tok) => lower.includes(tok));
          if (!hit) continue;

          // Compose the item's PDF-space transform with the viewport transform
          // to get viewport-space (canvas) pixel coordinates. tx[4] is left
          // edge x, tx[5] is the BASELINE y (in viewport coords, top-down).
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
          const horizScale = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
          const widthPx = (item.width || 0) * horizScale;
          if (widthPx <= 0 || fontHeight <= 0) continue;

          results.push({
            x: tx[4],
            y: tx[5] - fontHeight, // top edge = baseline minus font height
            width: widthPx,
            height: fontHeight,
            text: item.str,
          });
          // Cap to keep render cheap for hyper-dense pages.
          if (results.length >= 200) break;
        }
        if (!cancelled) setTextMatches(results);
      } catch (err) {
        console.warn("[pdf-viewer] text-highlight search failed:", err);
        if (!cancelled) setTextMatches([]);
      }
    };

    findMatches();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, currentPage, textHighlights]);

  // Track container size for overlay
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setOverlayDims({ width, height });
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pan: middle mouse always, RIGHT mouse always (so you can pan while
  // drawing measurements), left-click in select mode, or left-click when
  // holding space
  const canPan = activeTool === "select" || isSpaceDown;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Right mouse (button 2) or middle mouse (button 1) → always pan
      // Left mouse (button 0) → pan only in select mode or when Space is held
      if (e.button === 2 || e.button === 1 || (e.button === 0 && canPan)) {
        isPanning.current = true;
        panStart.current = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
        e.preventDefault();
      }
    },
    [canPan, panOffset]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning.current) {
        onPanOffsetChange({
          x: e.clientX - panStart.current.x,
          y: e.clientY - panStart.current.y,
        });
      }
    },
    [onPanOffsetChange]
  );

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  // Zoom to mouse cursor position with scroll wheel (no Ctrl needed)
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.05 : 0.05; // 5% increments for smooth zoom
      const newZoom = Math.max(0.1, Math.min(10, zoom + delta));
      if (newZoom === zoom) return;

      // Zoom centered on cursor position
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;
        // Point in PDF space under cursor before zoom
        const pdfX = (cursorX - panOffset.x) / zoom;
        const pdfY = (cursorY - panOffset.y) / zoom;
        // New pan so that same PDF point stays under cursor
        const newPanX = cursorX - pdfX * newZoom;
        const newPanY = cursorY - pdfY * newZoom;
        onPanOffsetChange({ x: newPanX, y: newPanY });
      }
      onZoomChange(newZoom);
    },
    [zoom, onZoomChange, panOffset, onPanOffsetChange]
  );

  const handlePageInputSubmit = () => {
    const p = parseInt(pageInput, 10);
    if (p >= 1 && p <= pageCount) {
      onPageChange(p);
    } else {
      setPageInput(String(currentPage));
    }
  };

  // Cursor: grab when panning is available, crosshair when measuring
  const cursorClass = canPan
    ? "cursor-grab active:cursor-grabbing"
    : "cursor-crosshair";

  return (
    <div className="flex flex-col h-full">
      {/* Page navigation bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30 shrink-0 relative z-10">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage <= 1}
          title="Previous page  [ "
        >
          ◀ Prev
        </Button>
        <div className="flex items-center gap-1 text-sm">
          <Input
            className="w-14 h-7 text-center text-sm"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={handlePageInputSubmit}
            onKeyDown={(e) => e.key === "Enter" && handlePageInputSubmit()}
          />
          <span className="text-muted-foreground">/ {pageCount}</span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(Math.min(pageCount, currentPage + 1))}
          disabled={currentPage >= pageCount}
          title="Next page  ]"
        >
          Next ▶
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => onZoomChange(Math.max(0.1, zoom - 0.1))} title="Zoom out  -">
            −
          </Button>
          <span className="text-sm w-14 text-center font-mono">{Math.round(zoom * 100)}%</span>
          <Button variant="outline" size="sm" onClick={() => onZoomChange(Math.min(10, zoom + 0.1))} title="Zoom in  +">
            +
          </Button>
          <Button variant="outline" size="sm" onClick={() => onZoomChange(1)} title="Reset zoom">
            Fit
          </Button>
        </div>
        {rendering && (
          <span className="text-xs text-muted-foreground animate-pulse">Rendering...</span>
        )}
      </div>

      {/* PDF canvas with pan/zoom */}
      <div
        ref={containerRef}
        className={`flex-1 overflow-hidden relative bg-gray-200 ${cursorClass}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()} // Suppress right-click menu so right-drag pans
      >
        {loadError ? (
          <div className="absolute inset-0 flex items-center justify-center p-6">
            <div className="max-w-md rounded border border-red-200 bg-red-50 p-4 text-sm text-red-900">
              <p className="font-semibold mb-2">{loadError.title}</p>
              <p>{loadError.detail}</p>
            </div>
          </div>
        ) : null}
        <div
          style={{
            transform: `translate(${panOffset.x}px, ${panOffset.y}px)`,
            position: "absolute",
            top: 0,
            left: 0,
          }}
        >
          <canvas ref={canvasRef} className="shadow-lg" />
          {/* Text-search highlight boxes — sit OVER the canvas in the same
              transform so they pan/zoom together. Each match was captured
              in scale=1 viewport pixels; multiplied by current zoom here. */}
          {textMatches.length > 0 && (
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                pointerEvents: "none",
              }}
            >
              {textMatches.map((m, i) => (
                <div
                  key={i}
                  title={m.text}
                  style={{
                    position: "absolute",
                    left: m.x * zoom,
                    top: m.y * zoom,
                    width: m.width * zoom,
                    height: m.height * zoom,
                    backgroundColor: "rgba(255, 235, 0, 0.42)",
                    boxShadow:
                      "0 0 0 1.5px rgba(220, 150, 0, 0.85), 0 0 8px rgba(255, 220, 0, 0.5)",
                    borderRadius: 1,
                  }}
                />
              ))}
            </div>
          )}
        </div>

        {/* Measurement overlay — rendered inside the same container as the PDF */}
        {renderOverlay && overlayDims.width > 0 && overlayDims.height > 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              pointerEvents: activeTool === "select" && !isSpaceDown ? "none" : "auto",
            }}
          >
            {renderOverlay(overlayDims.width, overlayDims.height)}
          </div>
        )}
      </div>
    </div>
  );
}
