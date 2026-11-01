export interface ExtractionData {
  id: string;
  name: string;
  provider?: string;
  scalePixelsPerFoot: number | null;
  scaleCalibrationJson: string | null;
  scalePerPageJson: string | null;
  pageCount: number | null;
  items?: Array<{
    id: string;
    name: string;
    measurementType: string;
    system: string;
    unit: string;
    quantity: number;
    sourceSheetId: string | null;
    evidence: string | null;
    sourcePages: string | null;
  }>;
}

export interface TargetItem {
  id: string;
  name: string;
  originalName: string;
  measurementType: "area" | "count" | "linear";
  system: "water" | "storm_drain" | "wastewater" | "other";
  unit: string;
  sourceSheetId: string | null;
  evidence: string | null;
}

export interface AddToItemsData {
  name: string;
  measurementType: "area" | "count" | "linear";
  system: "water" | "storm_drain" | "wastewater" | "other";
  quantity: number;
}

export interface AiMeasureItem {
  id: string;
  name: string;
  originalName: string;
  measurementType: "area" | "count" | "linear";
  system: "water" | "storm_drain" | "wastewater" | "other";
  unit: string;
  quantity: number;
  sourceSheetId: string | null;
  evidence: string | null;
  needsMeasurement: boolean;
  page: number;
}

export interface PendingPlaceholder {
  type: "linear" | "area" | "count";
  page: number;
  label: string;
  color: string;
}

export interface PendingScaleSettings {
  distanceFt: number;
  applyToAllPages: boolean;
  autoCreateDimensionLine: boolean;
}

export interface AutoScaleResult {
  notation: string;
  barStart: { x: number; y: number };
  barEnd: { x: number; y: number };
  barLengthFeet: number;
  page: number;
  pixelsPerFoot: number;
  confidence: number;
}
