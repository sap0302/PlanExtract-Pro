"use client";

import { CalibrationDistanceDialog } from "./calibration-distance-dialog";
import { PropertiesDialog, type MeasurementStyle } from "./properties-dialog";
import { ScaleDialog } from "./scale-dialog";
import type { PendingScaleSettings } from "../types";
import type { Point } from "@/lib/measurement-utils";

export function MeasureDialogs({
  showCalibrationDialog,
  calibrationDistance,
  onDistanceChange,
  onSubmitCalibration,
  onCancelCalibration,
  showScaleDialog,
  onCloseScaleDialog,
  onConfirmStandard,
  onConfirmAuto,
  onDetectAuto,
  autoScaleLoading,
  autoScaleResult,
  hideAutoTab,
  showAreaProperties,
  showLinearProperties,
  showCountProperties,
  areaStyle,
  linearStyle,
  countStyle,
  onCloseArea,
  onCloseLinear,
  onCloseCount,
  onConfirmArea,
  onConfirmLinear,
  onConfirmCount,
}: {
  showCalibrationDialog: boolean;
  calibrationDistance: string;
  onDistanceChange: (value: string) => void;
  onSubmitCalibration: () => void;
  onCancelCalibration: () => void;
  showScaleDialog: boolean;
  onCloseScaleDialog: () => void;
  onConfirmStandard: (settings: PendingScaleSettings) => void;
  onConfirmAuto: (applyToAllPages: boolean, autoCreateDimensionLine: boolean) => void;
  onDetectAuto: () => void;
  autoScaleLoading: boolean;
  autoScaleResult: {
    notation: string;
    barStart: Point;
    barEnd: Point;
    barLengthFeet: number;
    page: number;
    pixelsPerFoot: number;
    confidence: number;
  } | null;
  hideAutoTab: boolean;
  showAreaProperties: boolean;
  showLinearProperties: boolean;
  showCountProperties: boolean;
  areaStyle: MeasurementStyle;
  linearStyle: MeasurementStyle;
  countStyle: MeasurementStyle;
  onCloseArea: () => void;
  onCloseLinear: () => void;
  onCloseCount: () => void;
  onConfirmArea: (style: MeasurementStyle) => void;
  onConfirmLinear: (style: MeasurementStyle) => void;
  onConfirmCount: (style: MeasurementStyle) => void;
}) {
  return (
    <>
      {showCalibrationDialog && (
        <CalibrationDistanceDialog
          distance={calibrationDistance}
          onDistanceChange={onDistanceChange}
          onConfirm={onSubmitCalibration}
          onCancel={onCancelCalibration}
        />
      )}
      <ScaleDialog
        open={showScaleDialog}
        onClose={onCloseScaleDialog}
        onConfirmStandard={onConfirmStandard}
        onConfirmAuto={(_detected, applyToAllPages, autoCreateDimensionLine) =>
          onConfirmAuto(applyToAllPages, autoCreateDimensionLine)
        }
        onDetectAuto={onDetectAuto}
        autoScaleLoading={autoScaleLoading}
        autoScaleResult={autoScaleResult}
        hideAutoTab={hideAutoTab}
      />
      <PropertiesDialog
        open={showAreaProperties}
        toolLabel="Area"
        value={areaStyle}
        onClose={onCloseArea}
        onConfirm={onConfirmArea}
      />
      <PropertiesDialog
        open={showLinearProperties}
        toolLabel="Linear"
        value={linearStyle}
        onClose={onCloseLinear}
        onConfirm={onConfirmLinear}
      />
      <PropertiesDialog
        open={showCountProperties}
        toolLabel="New Count"
        value={countStyle}
        showShape
        onClose={onCloseCount}
        onConfirm={onConfirmCount}
      />
    </>
  );
}
