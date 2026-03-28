/**
 * Measurement utilities for the interactive PDF measurement tool.
 * All coordinate inputs are in PDF coordinate space (origin at bottom-left).
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * Compute the Euclidean distance between two points.
 */
export function distanceBetween(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute the total length of a polyline in real-world feet.
 * @param points Array of {x, y} coordinates in PDF pixel space
 * @param pixelsPerFoot Scale ratio from calibration
 * @returns Length in feet
 */
export function computePolylineLength(
  points: Point[],
  pixelsPerFoot: number
): number {
  if (points.length < 2 || pixelsPerFoot <= 0) return 0;

  let totalPixels = 0;
  for (let i = 1; i < points.length; i++) {
    totalPixels += distanceBetween(points[i - 1], points[i]);
  }

  return totalPixels / pixelsPerFoot;
}

/**
 * Compute the area of a polygon in real-world square feet using the Shoelace formula.
 * @param points Array of {x, y} coordinates in PDF pixel space (polygon vertices)
 * @param pixelsPerFoot Scale ratio from calibration
 * @returns Area in square feet
 */
export function computePolygonArea(
  points: Point[],
  pixelsPerFoot: number
): number {
  if (points.length < 3 || pixelsPerFoot <= 0) return 0;

  // Shoelace formula
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  area = Math.abs(area) / 2;

  // Convert from pixel^2 to ft^2
  return area / (pixelsPerFoot * pixelsPerFoot);
}

/**
 * Convert PDF coordinates (origin bottom-left, Y up) to canvas coordinates (origin top-left, Y down).
 */
export function pdfToCanvas(
  point: Point,
  pdfHeight: number
): Point {
  return { x: point.x, y: pdfHeight - point.y };
}

/**
 * Convert canvas coordinates (origin top-left, Y down) to PDF coordinates (origin bottom-left, Y up).
 */
export function canvasToPdf(
  point: Point,
  pdfHeight: number
): Point {
  return { x: point.x, y: pdfHeight - point.y };
}

/**
 * Format a measurement value for display.
 */
export function formatMeasurement(
  type: string,
  valueFt: number | null,
  valueCount: number | null
): string {
  if (type === "count") return `${valueCount ?? 1} EA`;
  if (type === "area") return `${(valueFt ?? 0).toFixed(2)} SQ FT`;
  return `${(valueFt ?? 0).toFixed(2)} FT`;
}
