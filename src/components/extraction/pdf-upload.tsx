"use client";

import { useState, useCallback, useEffect } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

interface PdfInfo {
  pageCount: number;
  fileSize: number;
  needsSplitting: boolean;
}

export function PdfUpload() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState("");
  const [pdfInfo, setPdfInfo] = useState<PdfInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);
  const [showPageSelector, setShowPageSelector] = useState(false);
  const [pageRanges, setPageRanges] = useState("");
  const [enableVerification, setEnableVerification] = useState(false);
  const [provider, setProvider] = useState("");
  const [scale, setScale] = useState("");
  const [customScale, setCustomScale] = useState("");

  // Get PDF info client-side (avoids Vercel body size limits)
  useEffect(() => {
    if (!file) {
      setPdfInfo(null);
      setShowPageSelector(false);
      setPageRanges("");
      return;
    }

    const fetchInfo = async () => {
      setLoadingInfo(true);
      try {
        const { PDFDocument } = await import("pdf-lib");
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
        const pageCount = pdf.getPageCount();
        const estimatedBase64Size = Math.ceil(file.size * 1.34);
        const needsSplitting = estimatedBase64Size > 20 * 1024 * 1024;
        setPdfInfo({ pageCount, fileSize: file.size, needsSplitting });
      } catch {
        console.warn("Could not read PDF info");
      } finally {
        setLoadingInfo(false);
      }
    };

    fetchInfo();
  }, [file]);

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
    if (!name) {
      setName(f.name.replace(/\.pdf$/i, ""));
    }
  }, [name]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) handleFile(f);
    },
    [handleFile]
  );

  const handleRemoveFile = () => {
    setFile(null);
    setPdfInfo(null);
    setShowPageSelector(false);
    setPageRanges("");
  };

  const handleQuickSelect = (type: "all" | "first-half" | "second-half") => {
    if (!pdfInfo) return;
    const total = pdfInfo.pageCount;
    const half = Math.ceil(total / 2);

    switch (type) {
      case "all":
        setPageRanges("");
        break;
      case "first-half":
        setPageRanges(`1-${half}`);
        break;
      case "second-half":
        setPageRanges(`${half + 1}-${total}`);
        break;
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    setProcessing(true);
    setStatus("Uploading plan...");

    try {
      // Step 1: Upload PDF via chunked upload (avoids Vercel 4.5MB body limit)
      setStatus("Uploading plan to cloud storage...");

      const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks (~2.7MB base64, safe under 4.5MB limit)
      const arrayBuffer = await file.arrayBuffer();
      const totalBytes = arrayBuffer.byteLength;
      const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);

      // Step 1: Create multipart upload
      const createRes = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", fileName: file.name }),
      });
      if (!createRes.ok) throw new Error("Failed to initialize upload");
      const { uploadId, key } = await createRes.json();

      // Step 2: Upload each part
      const parts: Array<{ etag: string; partNumber: number }> = [];
      for (let i = 0; i < totalChunks; i++) {
        setStatus(`Uploading plan... ${Math.round(((i + 1) / totalChunks) * 100)}%`);
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, totalBytes);
        const chunk = arrayBuffer.slice(start, end);
        const chunkBase64 = btoa(
          new Uint8Array(chunk).reduce((s, b) => s + String.fromCharCode(b), "")
        );

        const partRes = await fetch("/api/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "upload-part",
            uploadId,
            key,
            partNumber: i + 1,
            chunkData: chunkBase64,
          }),
        });

        if (!partRes.ok) {
          const err = await partRes.json().catch(() => ({ error: "Upload failed" }));
          throw new Error(err.error || `Failed to upload part ${i + 1}`);
        }

        const partResult = await partRes.json();
        parts.push({ etag: partResult.etag, partNumber: partResult.partNumber });
      }

      // Step 3: Complete multipart upload
      setStatus("Finalizing upload...");
      const completeRes = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete", uploadId, key, parts }),
      });
      if (!completeRes.ok) throw new Error("Failed to complete upload");
      const { url: blobUrl } = await completeRes.json();

      // Step 2: Send extraction request with blob URL
      setStatus("Analyzing plan with AI... This may take 30-60 seconds.");

      const formData = new FormData();
      formData.append("blobUrl", blobUrl);
      formData.append("fileName", file.name);
      formData.append("fileSize", String(file.size));
      formData.append("name", name || file.name);

      // Include page ranges if specified
      if (pageRanges.trim()) {
        formData.append("pageRanges", pageRanges.trim());
      }

      // Include verification toggle
      if (enableVerification) {
        formData.append("enableVerification", "true");
      }

      // Include provider selection (skip if "default" or empty — let server use user's default)
      if (provider && provider !== "default") {
        formData.append("provider", provider);
      }

      // Include plan scale if specified
      const effectiveScale = scale === "custom" ? customScale.trim() : scale;
      if (effectiveScale) {
        formData.append("scale", effectiveScale);
      }

      if (pdfInfo?.needsSplitting && !pageRanges.trim()) {
        setStatus(
          "Processing large plan... It will be split into chunks."
        );
      } else {
        setStatus("Analyzing plan with AI... This may take 30-60 seconds.");
      }

      const res = await fetch("/api/extract", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Extraction failed");
      }

      toast.success("Extraction completed successfully!");
      router.push(`/extractions/${data.extractionId}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Extraction failed"
      );
      setProcessing(false);
      setStatus("");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload Construction Plan</CardTitle>
        <CardDescription>
          Upload a construction plan PDF. The AI will analyze it
          and produce a PlanSwift-style quantity takeoff.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="name">Project Name</Label>
            <Input
              id="name"
              placeholder="e.g., Main Street Water Main Replacement"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={processing}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider">AI Provider</Label>
            <Select
              value={provider}
              onValueChange={setProvider}
              disabled={processing}
            >
              <SelectTrigger id="provider">
                <SelectValue placeholder="Use default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Use default</SelectItem>
                <SelectItem value="consensus">Consensus (All Providers)</SelectItem>
                <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
                <SelectItem value="openai">OpenAI (GPT-5.2)</SelectItem>
                <SelectItem value="gemini">Google (Gemini 2.5 Pro)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Override the default provider for this extraction. Configure keys
              in Settings.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="scale">Plan Scale (optional)</Label>
            <Select
              value={scale}
              onValueChange={(val) => {
                setScale(val);
                if (val !== "custom") setCustomScale("");
              }}
              disabled={processing}
            >
              <SelectTrigger id="scale">
                <SelectValue placeholder="AI will detect from sheets" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">AI will detect from sheets</SelectItem>
                <SelectItem value={`1" = 10'`}>1&quot; = 10&apos;</SelectItem>
                <SelectItem value={`1" = 20'`}>1&quot; = 20&apos;</SelectItem>
                <SelectItem value={`1" = 30'`}>1&quot; = 30&apos;</SelectItem>
                <SelectItem value={`1" = 40'`}>1&quot; = 40&apos;</SelectItem>
                <SelectItem value={`1" = 50'`}>1&quot; = 50&apos;</SelectItem>
                <SelectItem value={`1" = 60'`}>1&quot; = 60&apos;</SelectItem>
                <SelectItem value={`1" = 100'`}>1&quot; = 100&apos;</SelectItem>
                <SelectItem value="custom">Custom scale...</SelectItem>
              </SelectContent>
            </Select>
            {scale === "custom" && (
              <Input
                placeholder={`e.g., 1" = 25', HORIZ: 1" = 50'`}
                value={customScale}
                onChange={(e) => setCustomScale(e.target.value)}
                disabled={processing}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Providing the plan scale improves measurement accuracy for pipe lengths and areas.
            </p>
          </div>

          <div
            className={`relative rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
              dragOver
                ? "border-primary bg-primary/5"
                : file
                ? "border-green-500 bg-green-50 dark:bg-green-950/20"
                : "border-muted-foreground/25 hover:border-muted-foreground/50"
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            {file ? (
              <div className="space-y-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-green-600"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="m9 15 2 2 4-4"/></svg>
                <p className="font-medium">{file.name}</p>
                <p className="text-sm text-muted-foreground">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                  {loadingInfo && " — Reading page info..."}
                  {pdfInfo && ` — ${pdfInfo.pageCount} pages`}
                </p>
                {!processing && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleRemoveFile}
                  >
                    Remove
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-muted-foreground"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>
                <p className="text-muted-foreground">
                  Drag and drop your PDF here, or click to browse
                </p>
                <p className="text-xs text-muted-foreground">
                  PDF files up to 150MB — large files are split automatically
                </p>
                <input
                  type="file"
                  accept=".pdf,application/pdf"
                  className="absolute inset-0 cursor-pointer opacity-0"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                  disabled={processing}
                />
              </div>
            )}
          </div>

          {/* Large file auto-split info banner */}
          {pdfInfo?.needsSplitting && !pageRanges.trim() && (
            <div className="flex items-start gap-3 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-4">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-blue-600 dark:text-blue-400"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
              <div className="text-sm text-blue-800 dark:text-blue-200">
                <p className="font-medium">Large PDF detected</p>
                <p className="mt-1">
                  This file will be automatically split into smaller chunks for
                  processing. You can also select specific pages below to reduce
                  processing time.
                </p>
              </div>
            </div>
          )}

          {/* Page range selector — shown when a file with page info is loaded */}
          {file && pdfInfo && !processing && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  className="text-sm font-medium text-primary hover:underline"
                  onClick={() => setShowPageSelector(!showPageSelector)}
                >
                  {showPageSelector ? "Hide page selector" : "Select specific pages (optional)"}
                </button>
                {showPageSelector && pageRanges.trim() && (
                  <button
                    type="button"
                    className="text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setPageRanges("")}
                  >
                    Clear selection
                  </button>
                )}
              </div>

              {showPageSelector && (
                <div className="space-y-3 rounded-lg border p-4">
                  <div className="space-y-2">
                    <Label htmlFor="pageRanges" className="text-sm">
                      Page ranges
                    </Label>
                    <Input
                      id="pageRanges"
                      placeholder={`e.g., 1-10, 15-20, 25 (1-${pdfInfo.pageCount} available)`}
                      value={pageRanges}
                      onChange={(e) => setPageRanges(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Enter page numbers or ranges separated by commas.
                      Leave empty to process all {pdfInfo.pageCount} pages.
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleQuickSelect("all")}
                      className={!pageRanges.trim() ? "border-primary text-primary" : ""}
                    >
                      All pages
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleQuickSelect("first-half")}
                      className={pageRanges === `1-${Math.ceil(pdfInfo.pageCount / 2)}` ? "border-primary text-primary" : ""}
                    >
                      First half (1-{Math.ceil(pdfInfo.pageCount / 2)})
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleQuickSelect("second-half")}
                      className={pageRanges === `${Math.ceil(pdfInfo.pageCount / 2) + 1}-${pdfInfo.pageCount}` ? "border-primary text-primary" : ""}
                    >
                      Second half ({Math.ceil(pdfInfo.pageCount / 2) + 1}-{pdfInfo.pageCount})
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Verification toggle */}
          {file && !processing && (
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div>
                <Label className="text-sm font-medium">
                  Verify quantities (2-pass)
                </Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Runs a second AI review to double-check quantities. Takes
                  ~30s extra.
                </p>
              </div>
              <Switch
                checked={enableVerification}
                onCheckedChange={setEnableVerification}
              />
            </div>
          )}

          {processing && (
            <div className="flex items-center gap-3 rounded-lg bg-muted p-4">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm">{status}</span>
            </div>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={!file || processing}
            size="lg"
          >
            {processing ? "Processing..." : "Start Extraction"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
