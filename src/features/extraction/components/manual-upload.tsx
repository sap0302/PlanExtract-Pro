"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";

/**
 * Manual mode: no AI call at all — just stores the PDF and jumps straight
 * to the measure/takeoff UI so every item gets drawn by hand. Deliberately
 * a much smaller form than PdfUpload (AI Provider / Plan Scale / page-range
 * / verification options are all meaningless without an AI extraction).
 */
export function ManualUpload({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);

  const handleFile = useCallback((f: File) => {
    if (f.type !== "application/pdf") {
      toast.error("Please upload a PDF file");
      return;
    }
    if (f.size > 150 * 1024 * 1024) {
      toast.error("File size exceeds 150MB limit");
      return;
    }
    setFile(f);
    setName((prev) => prev || f.name.replace(/\.pdf$/i, ""));
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setProcessing(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("name", name || file.name);

      const res = await fetch("/api/extractions/manual", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to start manual measuring");
      }

      router.push(`/extractions/${data.extractionId}/measure`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start manual measuring");
      setProcessing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Manual Mode</CardTitle>
            <CardDescription>
              Upload a construction plan PDF and go straight to the measure tool -
              no AI extraction, draw and count everything by hand.
            </CardDescription>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onBack} disabled={processing}>
            ← Change mode
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="manual-name">Project Name</Label>
            <Input
              id="manual-name"
              placeholder="e.g., Main Street Water Main Replacement"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={processing}
            />
          </div>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => document.getElementById("manual-file-input")?.click()}
            className={`border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors ${
              dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50"
            }`}
          >
            <input
              id="manual-file-input"
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
              disabled={processing}
            />
            {file ? (
              <div className="text-sm font-medium">{file.name}</div>
            ) : (
              <>
                <div className="text-sm font-medium">
                  Drag and drop your PDF here, or click to browse
                </div>
                <div className="text-xs text-muted-foreground mt-1">PDF files up to 150MB</div>
              </>
            )}
          </div>

          <Button type="submit" className="w-full" disabled={!file || processing}>
            {processing ? "Starting…" : "Start Manual Measuring"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
