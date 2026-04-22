"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

interface ExampleFormData {
  id?: string;
  name: string;
  projectType: string;
  rawText: string;
  isActive: boolean;
}

interface ExampleFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  initialData?: ExampleFormData;
}

const PROJECT_TYPES = [
  { value: "water", label: "Water" },
  { value: "storm_drain", label: "Storm Drain" },
  { value: "wastewater", label: "Wastewater" },
  { value: "mixed", label: "Mixed Utilities" },
  { value: "other", label: "Other" },
];

const PLANSWIFT_PLACEHOLDER = `All Items
Type: Area
Folder: Area
  REMOVE/REPLACE CONCRETE STORM   347.11 SQ FT
  GROUTED RIP RAP   132.00 SQ FT

Type: Count
Folder: Fittings
  8X8 TEE W   2 EA
  8" 45 WATER W   4 EA
Folder: Valves
  8" GATE VALVE W   11 EA
Folder: Hydrants
  FIRE HYDRANT W   6 EA

Type: Linear
Folder: Pipe
  8" DR18 W   1148.53 FT
  42" RCP SD   122.51 FT`;

export function ExampleFormDialog({
  open,
  onOpenChange,
  onSaved,
  initialData,
}: ExampleFormDialogProps) {
  const isEdit = !!initialData?.id;
  const [name, setName] = useState("");
  const [projectType, setProjectType] = useState("mixed");
  const [rawText, setRawText] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      if (initialData) {
        setName(initialData.name);
        setProjectType(initialData.projectType);
        setRawText(initialData.rawText);
        setIsActive(initialData.isActive);
      } else {
        setName("");
        setProjectType("mixed");
        setRawText("");
        setIsActive(true);
      }
    }
  }, [open, initialData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (rawText.trim().length < 10) {
      toast.error("Please paste your takeoff output (at least 10 characters)");
      return;
    }

    setSaving(true);
    try {
      const body = { name: name.trim(), projectType, rawText: rawText.trim(), isActive };
      const url = isEdit
        ? `/api/reference-examples/${initialData!.id}`
        : "/api/reference-examples";
      const method = isEdit ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to save");
      }

      toast.success(isEdit ? "Example updated" : "Example added");
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Reference Example" : "Add Reference Example"}
          </DialogTitle>
          <DialogDescription>
            Paste your verified takeoff extraction results. These will be used
            as reference examples to improve AI extraction accuracy.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="example-name">Name</Label>
            <Input
              id="example-name"
              placeholder="e.g., Water Main - Oak Street Project"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="project-type">Project Type</Label>
            <Select value={projectType} onValueChange={setProjectType} disabled={saving}>
              <SelectTrigger id="project-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROJECT_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="raw-text">Takeoff Output</Label>
            <Textarea
              id="raw-text"
              placeholder={PLANSWIFT_PLACEHOLDER}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              disabled={saving}
              className="min-h-[250px] font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Paste the full takeoff output. Include all items grouped by Type (Area, Count, Linear).
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <Label htmlFor="is-active" className="text-sm font-medium">
                Active
              </Label>
              <p className="text-xs text-muted-foreground">
                Active examples are used during extraction
              </p>
            </div>
            <Switch
              id="is-active"
              checked={isActive}
              onCheckedChange={setIsActive}
              disabled={saving}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : isEdit ? "Update" : "Add Example"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
