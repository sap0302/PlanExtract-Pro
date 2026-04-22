"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { ExampleFormDialog } from "./example-form-dialog";
import { ExampleDeleteButton } from "./example-delete-button";

interface ReferenceExample {
  id: string;
  name: string;
  projectType: string;
  rawText: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ExamplesListProps {
  initialExamples: ReferenceExample[];
}

const PROJECT_TYPE_CONFIG: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" }
> = {
  water: { label: "Water", variant: "default" },
  storm_drain: { label: "Storm Drain", variant: "secondary" },
  wastewater: { label: "destructive" as never, variant: "destructive" },
  mixed: { label: "Mixed", variant: "default" },
  other: { label: "Other", variant: "secondary" },
};

function getProjectTypeConfig(type: string) {
  return PROJECT_TYPE_CONFIG[type] || { label: type, variant: "secondary" as const };
}

function getProjectTypeBadgeClass(type: string): string {
  switch (type) {
    case "water":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
    case "storm_drain":
      return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300";
    case "wastewater":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
    case "mixed":
      return "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300";
    default:
      return "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300";
  }
}

function truncateText(text: string, maxLines: number = 3): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + "\n...";
}

export function ExamplesList({ initialExamples }: ExamplesListProps) {
  const router = useRouter();
  const [examples, setExamples] = useState(initialExamples);
  const [formOpen, setFormOpen] = useState(false);
  const [editData, setEditData] = useState<ReferenceExample | undefined>();

  const refresh = () => {
    router.refresh();
    // Also refetch client-side for immediate UI update
    fetch("/api/reference-examples")
      .then((res) => res.json())
      .then((data) => {
        if (data.referenceExamples) {
          setExamples(data.referenceExamples);
        }
      })
      .catch(() => {});
  };

  const handleToggleActive = async (id: string, isActive: boolean) => {
    // Optimistic update
    setExamples((prev) =>
      prev.map((ex) => (ex.id === id ? { ...ex, isActive } : ex))
    );

    try {
      const res = await fetch(`/api/reference-examples/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });

      if (!res.ok) {
        throw new Error("Failed to update");
      }

      toast.success(isActive ? "Example activated" : "Example deactivated");
    } catch {
      // Revert optimistic update
      setExamples((prev) =>
        prev.map((ex) => (ex.id === id ? { ...ex, isActive: !isActive } : ex))
      );
      toast.error("Failed to update example");
    }
  };

  const handleOpenCreate = () => {
    setEditData(undefined);
    setFormOpen(true);
  };

  const handleOpenEdit = (example: ReferenceExample) => {
    setEditData(example);
    setFormOpen(true);
  };

  const activeCount = examples.filter((ex) => ex.isActive).length;

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Reference Examples</h1>
          <p className="text-muted-foreground mt-1">
            Add verified results to improve AI extraction accuracy.
            {examples.length > 0 && (
              <span className="ml-1">
                {activeCount} of {examples.length} active.
              </span>
            )}
          </p>
        </div>
        <Button onClick={handleOpenCreate}>Add Example</Button>
      </div>

      {examples.length === 0 ? (
        <Card className="mt-6">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-muted-foreground/50 mb-4"
            >
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
            <h3 className="text-lg font-semibold">No reference examples yet</h3>
            <p className="text-sm text-muted-foreground mt-1 text-center max-w-md">
              Add your verified extraction results as reference
              examples. The AI will use these to produce more accurate quantity
              takeoffs that match your naming conventions.
            </p>
            <Button className="mt-4" onClick={handleOpenCreate}>
              Add Your First Example
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-6 space-y-4">
          {examples.map((example) => (
            <Card
              key={example.id}
              className={!example.isActive ? "opacity-60" : ""}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <CardTitle className="text-lg">{example.name}</CardTitle>
                    <CardDescription className="flex items-center gap-2">
                      <Badge
                        variant="secondary"
                        className={getProjectTypeBadgeClass(example.projectType)}
                      >
                        {getProjectTypeConfig(example.projectType).label}
                      </Badge>
                      <span>
                        {example.rawText.length.toLocaleString()} characters
                      </span>
                      <span>
                        ~{Math.ceil(example.rawText.length / 4).toLocaleString()} tokens
                      </span>
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {example.isActive ? "Active" : "Inactive"}
                      </span>
                      <Switch
                        checked={example.isActive}
                        onCheckedChange={(checked) =>
                          handleToggleActive(example.id, checked)
                        }
                      />
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <pre className="rounded-lg bg-muted p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-[120px] overflow-y-auto">
                  {truncateText(example.rawText, 6)}
                </pre>
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleOpenEdit(example)}
                  >
                    Edit
                  </Button>
                  <ExampleDeleteButton
                    exampleId={example.id}
                    exampleName={example.name}
                    onDeleted={refresh}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ExampleFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        onSaved={refresh}
        initialData={editData}
      />
    </>
  );
}
