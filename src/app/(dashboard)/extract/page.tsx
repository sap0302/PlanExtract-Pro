import { ExtractionModeSelect } from "@/features/extraction";

export default function ExtractPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold">New Extraction</h1>
        <p className="text-muted-foreground mt-1">
          Upload a construction plan to extract a quantity takeoff
        </p>
      </div>
      <ExtractionModeSelect />
    </div>
  );
}
