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
  /** Reports the PDF's true page count once loaded client-side (authoritative — DB's cached pageCount may be null/stale). */
  onPageCountReady?: (pageCount: number) => void;
  activeTool: string;
  isSpaceDown: boolean;
  renderOverlay?: (width: number, height: number) => React.ReactNode;
  /** Hide the viewer's own page/zoom nav bar (used when a parent ribbon toolbar provides it). */
  hideNavBar?: boolean;
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
  onPageCountReady,
  activeTool,
  isSpaceDown,
  renderOverlay,
  textHighlights,
  hideNavBar,
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
  // The PDF page's size at scale=1. The canvas's CSS *display* size is always
  // basePdfSize * zoom (computed declaratively below, in lockstep with React's
  // render — no race possible). Its raster *resolution* (canvas.width/height
  // attribute) is separately set to basePdfSize * renderZoom, only when the
  // debounced re-render actually runs. Keeping "how big it looks" and "how
  // sharp it is" fully decoupled is what stops zoom from ever visibly
  // jumping: display size never depends on whether the raster has caught up.
  const [basePdfSize, setBasePdfSize] = useState({ width: 0, height: 0 });

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
          onPageCountReady?.(doc.numPages);
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

  // The zoom actually baked into the canvas's raster pixels. `zoom` itself
  // updates on every wheel tick for instant visual feedback (applied as a CSS
  // scale on the canvas, see the wrapper div below); `renderZoom` only catches
  // up after scrolling settles, so pdfjs's expensive page.render() doesn't run
  // on every tick (which was the cause of the "shaking" — a blank canvas +
  // cancelled render on every single wheel event while scrolling fast).
  const [renderZoom, setRenderZoom] = useState(zoom);
  const zoomDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current);
    zoomDebounceRef.current = setTimeout(() => setRenderZoom(zoom), 150);
    return () => {
      if (zoomDebounceRef.current) clearTimeout(zoomDebounceRef.current);
    };
  }, [zoom]);

  // Track active render task so we can cancel it on re-render
  const renderTaskRef = useRef<any | null>(null);
  // Off-screen scratch canvas pdfjs renders into. Resizing the VISIBLE canvas
  // (`canvas.width = ...`) clears it to blank immediately, and the actual
  // page.render() is async — rendering straight into the visible canvas means
  // it sits blank for the render's duration on every zoom/page change, which
  // reads as a flash/shake. Rendering into this hidden canvas instead, then
  // copying the finished pixels into the visible one with a single
  // resize+drawImage (synchronous, no `await` in between), means the browser
  // never has a chance to paint an intermediate blank frame.
  const bufferCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (!bufferCanvasRef.current && typeof document !== "undefined") {
    bufferCanvasRef.current = document.createElement("canvas");
  }

  // Latest panOffset / onPanOffsetChange / clamp fn, read inside the page-render
  // effect without adding them as deps (which would re-trigger PDF re-render).
  const panOffsetRef = useRef(panOffset);
  const onPanOffsetChangeRef = useRef(onPanOffsetChange);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clampPanOffsetRef = useRef<(offset: { x: number; y: number }) => { x: number; y: number }>(
    (offset) => offset
  );
  useEffect(() => {
    panOffsetRef.current = panOffset;
  }, [panOffset]);
  useEffect(() => {
    onPanOffsetChangeRef.current = onPanOffsetChange;
  }, [onPanOffsetChange]);

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
        const viewport = page.getViewport({ scale: renderZoom });
        const buffer = bufferCanvasRef.current!;
        const bufferCtx = buffer.getContext("2d")!;

        buffer.width = viewport.width;
        buffer.height = viewport.height;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const task = page.render({ canvasContext: bufferCtx, viewport } as any);
        renderTaskRef.current = task;
        await task.promise;
        renderTaskRef.current = null;
        if (cancelled) return;

        // Copy the finished render into the visible canvas in one
        // synchronous resize+draw — no blank frame in between.
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d")!;
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        ctx.drawImage(buffer, 0, 0);

        // Re-clamp pan immediately — a zoom-out or page change can leave the
        // previous pan offset pointing past the (now smaller) page's edge.
        const clamped = clampPanOffsetRef.current(panOffsetRef.current);
        if (clamped.x !== panOffsetRef.current.x || clamped.y !== panOffsetRef.current.y) {
          onPanOffsetChangeRef.current(clamped);
        }

        if (!cancelled) {
          const baseViewport = page.getViewport({ scale: 1 });
          setBasePdfSize({ width: baseViewport.width, height: baseViewport.height });
          onCanvasReady?.(canvas, baseViewport.width, baseViewport.height);
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
  }, [pdfDoc, currentPage, renderZoom, onCanvasReady]);

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
          let matchStart = -1;
          let matchLen = 0;
          for (const tok of tokens) {
            const idx = lower.indexOf(tok);
            if (idx !== -1) {
              matchStart = idx;
              matchLen = tok.length;
              break;
            }
          }
          if (matchStart === -1) continue;

          // Compose the item's PDF-space transform with the viewport transform
          // to get viewport-space (canvas) pixel coordinates. tx[4] is left
          // edge x, tx[5] is the BASELINE y (in viewport coords, top-down).
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
          const horizScale = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1]);
          const fullWidthPx = (item.width || 0) * horizScale;
          if (fullWidthPx <= 0 || fontHeight <= 0) continue;

          // Some PDFs encode a whole callout/leader-line label as ONE text
          // item — highlighting that item's full width for a short substring
          // match would cover unrelated neighboring text on the same line
          // (exactly what showed up as an oversized yellow box spanning past
          // the actual label). Narrow to a sub-rectangle proportional to
          // where the match falls within the string (assumes roughly even
          // character width — not exact, but far tighter than the full run).
          const strLen = item.str.length || 1;
          const subX = (matchStart / strLen) * fullWidthPx;
          const subWidth = Math.max((matchLen / strLen) * fullWidthPx, fontHeight);

          results.push({
            x: tx[4] + subX,
            y: tx[5] - fontHeight, // top edge = baseline minus font height
            width: subWidth,
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

  // Keep the rendered page from being dragged past its own edges — clamps
  // panOffset so the page (canvas.width/height, which already includes the
  // current zoom) can never leave a gap of empty gray space on a side where
  // the page is larger than the visible container. When the page is smaller
  // than the container on an axis, it clamps to keep the page from being
  // pushed out further than centered.
  const clampPanOffset = useCallback(
    (offset: { x: number; y: number }) => {
      const containerW = overlayDims.width;
      const containerH = overlayDims.height;
      if (containerW === 0 || containerH === 0) return offset;
      // The canvas's CSS display size is always basePdfSize * zoom (see the
      // canvas's inline style below) — independent of its raster resolution.
      const contentW = basePdfSize.width * zoom;
      const contentH = basePdfSize.height * zoom;
      if (contentW === 0 || contentH === 0) return offset;

      const clampAxis = (value: number, containerSize: number, contentSize: number) => {
        const lo = Math.min(0, containerSize - contentSize);
        const hi = Math.max(0, containerSize - contentSize);
        return Math.min(hi, Math.max(lo, value));
      };

      return {
        x: clampAxis(offset.x, containerW, contentW),
        y: clampAxis(offset.y, containerH, contentH),
      };
    },
    [overlayDims, zoom, basePdfSize]
  );
  useEffect(() => {
    clampPanOffsetRef.current = clampPanOffset;
  }, [clampPanOffset]);

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
        onPanOffsetChange(
          clampPanOffset({
            x: e.clientX - panStart.current.x,
            y: e.clientY - panStart.current.y,
          })
        );
      }
    },
    [onPanOffsetChange, clampPanOffset]
  );

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  // Zoom to mouse cursor position with scroll wheel (no Ctrl needed)
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.05 : 0.05; // 5% increments for smooth zoom
      // Never let the page's rendered height shrink smaller than the visible
      // viewport height — no gray space above/below the page.
      const minZoom = basePdfSize.height > 0 ? Math.max(0.1, overlayDims.height / basePdfSize.height) : 0.1;
      const newZoom = Math.max(minZoom, Math.min(10, zoom + delta));
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
        onPanOffsetChange(clampPanOffset({ x: newPanX, y: newPanY }));
      }
      onZoomChange(newZoom);
    },
    [zoom, onZoomChange, panOffset, onPanOffsetChange, clampPanOffset, basePdfSize, overlayDims]
  );

  const handlePageInputSubmit = () => {
    const p = parseInt(pageInput, 10);
    if (p >= 1 && p <= pageCount) {
      onPageChange(p);
    } else {
      setPageInput(String(currentPage));
    }
  };

  // Cursor: grab when panning is available; hidden while measuring since the
  // Konva overlay draws its own crosshair guide lines.
  const cursorClass = canPan
    ? "cursor-grab active:cursor-grabbing"
    : "cursor-none";

  return (
    <div className="flex flex-col h-full">
      {/* Page navigation bar */}
      {!hideNavBar && (
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
      )}

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
        {/* Loading overlay — covers the canvas while the PDF document itself
            is still loading/parsing (!pdfDoc), or while a page render is in
            flight (`rendering`). Previously this only showed as a small
            "Rendering..." text in the nav bar, which is hidden entirely when
            hideNavBar is set (as the measure page does), so large/slow PDFs
            just showed a blank gray box with no feedback. */}
        {!loadError && (!pdfDoc || (rendering && basePdfSize.width === 0)) && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-200/80 z-30">
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <span className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span className="text-sm font-medium">
                {!pdfDoc ? "Loading PDF…" : "Rendering page…"}
              </span>
            </div>
          </div>
        )}
        <div
          style={{
            // Only translate here — the canvas's own CSS width/height below
            // (basePdfSize * live zoom) handles zoom, so there's no separate
            // scale factor here that could ever desync from the raster.
            transform: `translate(${panOffset.x}px, ${panOffset.y}px)`,
            position: "absolute",
            top: 0,
            left: 0,
          }}
        >
          <canvas
            ref={canvasRef}
            className="shadow-lg"
            style={
              basePdfSize.width > 0
                ? { width: basePdfSize.width * zoom, height: basePdfSize.height * zoom }
                : undefined
            }
          />
          {/* Text-search highlight boxes — sit OVER the canvas in the same
              (translate-only) wrapper, positioned in live-zoom space to match
              the canvas's own CSS display size above. */}
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
