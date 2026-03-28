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
  lib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${lib.version}/build/pdf.worker.min.mjs`;
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

  // Load PDF document (dynamic import to avoid SSR DOMMatrix error)
  useEffect(() => {
    let cancelled = false;
    const loadPdf = async () => {
      try {
        const pdfjsLib = await getPdfjs();
        const doc = await pdfjsLib.getDocument(pdfUrl).promise;
        if (!cancelled) {
          setPdfDoc(doc);
          setPageCount(doc.numPages);
        }
      } catch (err) {
        console.error("Failed to load PDF:", err);
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

  // Pan: middle mouse always, left-click in select mode, or left-click when holding space
  const canPan = activeTool === "select" || isSpaceDown;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 || (e.button === 0 && canPan)) {
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

  // Zoom to mouse cursor position with Ctrl+scroll
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.15 : 0.15;
        const newZoom = Math.max(0.25, Math.min(5, zoom + delta));
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
      }
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
          <Button variant="outline" size="sm" onClick={() => onZoomChange(Math.max(0.25, zoom - 0.25))} title="Zoom out  -">
            −
          </Button>
          <span className="text-sm w-14 text-center font-mono">{Math.round(zoom * 100)}%</span>
          <Button variant="outline" size="sm" onClick={() => onZoomChange(Math.min(5, zoom + 0.25))} title="Zoom in  +">
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
      >
        <div
          style={{
            transform: `translate(${panOffset.x}px, ${panOffset.y}px)`,
            position: "absolute",
            top: 0,
            left: 0,
          }}
        >
          <canvas ref={canvasRef} className="shadow-lg" />
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
