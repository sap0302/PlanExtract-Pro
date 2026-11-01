"use client";

export function TargetItemBanner({
  name,
  measurementType,
  sourceSheetId,
}: {
  name: string;
  measurementType: string;
  sourceSheetId: string | null;
}) {
  return (
    <div className="px-4 py-2 bg-yellow-50 border-b border-yellow-200 text-sm shrink-0">
      <div className="flex items-center gap-3">
        <span className="text-lg">📐</span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-yellow-900">Measuring: {name}</div>
          <div className="text-xs text-yellow-800">
            Draw the <span className="font-medium">{measurementType}</span> on the plan using
            the tools at left, then click <span className="font-medium">&quot;Add to items&quot;</span>{" "}
            to link the measurement to this row and update its quantity.
            {sourceSheetId && (
              <>
                {" "}
                Source sheet: <span className="font-mono">{sourceSheetId}</span>.
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
