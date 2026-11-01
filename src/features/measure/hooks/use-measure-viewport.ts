"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useMeasureViewport() {
  const viewportDimsRef = useRef({ width: 800, height: 600 });
  const pdfDimensionsRef = useRef({ width: 0, height: 0 });
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);

  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [pdfDimensions, setPdfDimensions] = useState({ width: 0, height: 0 });

  const zoomRef = useRef(zoom);
  const panOffsetRef = useRef(panOffset);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    panOffsetRef.current = panOffset;
  }, [panOffset]);

  const clampPanOffset = useCallback((offset: { x: number; y: number }, atZoom: number) => {
    const cw = viewportDimsRef.current.width;
    const ch = viewportDimsRef.current.height;
    const contentW = pdfDimensionsRef.current.width * atZoom;
    const contentH = pdfDimensionsRef.current.height * atZoom;
    if (cw === 0 || ch === 0 || contentW === 0 || contentH === 0) return offset;
    const clampAxis = (value: number, containerSize: number, contentSize: number) => {
      const lo = Math.min(0, containerSize - contentSize);
      const hi = Math.max(0, containerSize - contentSize);
      return Math.min(hi, Math.max(lo, value));
    };
    return {
      x: clampAxis(offset.x, cw, contentW),
      y: clampAxis(offset.y, ch, contentH),
    };
  }, []);

  const getMinZoom = useCallback(() => {
    const ch = viewportDimsRef.current.height;
    const pageH = pdfDimensionsRef.current.height;
    if (!pageH) return 0.1;
    return Math.max(0.1, ch / pageH);
  }, []);

  const zoomTo = useCallback(
    (requestedZoom: number) => {
      const newZoom = Math.max(getMinZoom(), requestedZoom);
      const cw = viewportDimsRef.current.width;
      const ch = viewportDimsRef.current.height;
      const anchor = cursorPosRef.current ?? { x: cw / 2, y: ch / 2 };
      const z = zoomRef.current;
      const po = panOffsetRef.current;
      const localCx = (anchor.x - po.x) / z;
      const localCy = (anchor.y - po.y) / z;
      setZoom(newZoom);
      setPanOffset(
        clampPanOffset(
          { x: anchor.x - localCx * newZoom, y: anchor.y - localCy * newZoom },
          newZoom
        )
      );
    },
    [clampPanOffset, getMinZoom]
  );

  const fitPage = useCallback(() => {
    const newZoom = Math.max(getMinZoom(), 1);
    const cw = viewportDimsRef.current.width;
    const ch = viewportDimsRef.current.height;
    const z = zoomRef.current;
    const po = panOffsetRef.current;
    const localCx = (cw / 2 - po.x) / z;
    const localCy = (ch / 2 - po.y) / z;
    setZoom(newZoom);
    setPanOffset(
      clampPanOffset({ x: cw / 2 - localCx * newZoom, y: ch / 2 - localCy * newZoom }, newZoom)
    );
  }, [clampPanOffset, getMinZoom]);

  const handleCanvasReady = useCallback((_canvas: HTMLCanvasElement, pdfW: number, pdfH: number) => {
    setPdfDimensions({ width: pdfW, height: pdfH });
    pdfDimensionsRef.current = { width: pdfW, height: pdfH };
  }, []);

  const centerOn = useCallback(
    (cx: number, cy: number, minZoom = 1.2) => {
      const cw = viewportDimsRef.current.width;
      const ch = viewportDimsRef.current.height;
      const targetZoom = Math.max(zoom, minZoom);
      setZoom(targetZoom);
      setPanOffset({
        x: cw / 2 - cx * targetZoom,
        y: ch / 2 - cy * targetZoom,
      });
    },
    [zoom]
  );

  return {
    zoom,
    setZoom,
    panOffset,
    setPanOffset,
    pdfDimensions,
    zoomRef,
    panOffsetRef,
    viewportDimsRef,
    cursorPosRef,
    clampPanOffset,
    zoomTo,
    fitPage,
    handleCanvasReady,
    centerOn,
  };
}
