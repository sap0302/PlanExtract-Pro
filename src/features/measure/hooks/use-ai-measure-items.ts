"use client";

import { useMemo } from "react";
import { deriveAiMeasureItems, highlightTokensForPage } from "../lib/ai-items";
import type { ExtractionData } from "../types";
import type { MeasurementShape } from "../components/measurement-canvas";

export function useAiMeasureItems(
  extraction: ExtractionData | null,
  measurements: MeasurementShape[],
  currentPage: number,
  extraHighlights: string[]
) {
  const aiItems = useMemo(
    () => deriveAiMeasureItems(extraction, measurements),
    [extraction, measurements]
  );

  const currentPageAiItemHighlights = useMemo(
    () => highlightTokensForPage(aiItems, currentPage),
    [aiItems, currentPage]
  );

  const combinedTextHighlights = useMemo(
    () => [...extraHighlights, ...currentPageAiItemHighlights],
    [extraHighlights, currentPageAiItemHighlights]
  );

  return { aiItems, combinedTextHighlights };
}
