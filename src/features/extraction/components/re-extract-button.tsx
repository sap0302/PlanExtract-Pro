"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ReExtractButtonProps {
  extractionId: string;
  extractionName: string;
}

export function ReExtractButton({ extractionId, extractionName }: ReExtractButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleReExtract = async () => {
    if (!confirm(`Re-extract "${extractionName}"? This will create a new extraction using the stored PDF.`)) return;

    setLoading(true);
    try {
      const res = await fetch(`/api/extractions/${extractionId}/re-extract`, {
        method: "POST",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Re-extraction failed");
      }

      const data = await res.json();
      toast.success("Re-extraction started!");
      router.push(`/extractions/${data.extractionId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Re-extraction failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button variant="outline" onClick={handleReExtract} disabled={loading}>
      {loading ? "Starting..." : "Re-extract"}
    </Button>
  );
}
