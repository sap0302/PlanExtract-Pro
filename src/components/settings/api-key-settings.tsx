"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

interface KeyStatus {
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  hasGeminiKey: boolean;
  preferredProvider: string;
  geminiModel: string;
  claudeModel: string;
  openaiModel: string;
  customInstructions: string;
}

const MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  anthropic: [
    { value: "_default", label: "Default (Sonnet)" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4" },
    { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
  ],
  openai: [
    { value: "_default", label: "Default (GPT-5.4)" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.2", label: "GPT-5.2" },
    { value: "gpt-4o", label: "GPT-4o" },
  ],
  gemini: [
    { value: "_default", label: "Default (2.5 Flash)" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
};

const PROVIDERS = [
  {
    id: "anthropic" as const,
    label: "Anthropic (Claude)",
    keyField: "anthropicKey" as const,
    hasField: "hasAnthropicKey" as const,
    modelField: "claudeModel" as const,
    placeholder: "sk-ant-api03-...",
  },
  {
    id: "openai" as const,
    label: "OpenAI (GPT-4o)",
    keyField: "openaiKey" as const,
    hasField: "hasOpenaiKey" as const,
    modelField: "openaiModel" as const,
    placeholder: "sk-...",
  },
  {
    id: "gemini" as const,
    label: "Google (Gemini)",
    keyField: "geminiKey" as const,
    hasField: "hasGeminiKey" as const,
    modelField: "geminiModel" as const,
    placeholder: "AIza...",
  },
];

export function ApiKeySettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [keys, setKeys] = useState({
    anthropicKey: "",
    openaiKey: "",
    geminiKey: "",
  });
  const [preferredProvider, setPreferredProvider] = useState("anthropic");
  const [models, setModels] = useState({
    geminiModel: "_default",
    claudeModel: "_default",
    openaiModel: "_default",
  });
  const [customInstructions, setCustomInstructions] = useState("");

  // Track which fields the user has actually edited
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    try {
      const res = await fetch("/api/settings/keys");
      if (!res.ok) throw new Error("Failed to load settings");
      const data: KeyStatus = await res.json();
      setStatus(data);
      setPreferredProvider(data.preferredProvider);
      setModels({
        geminiModel: data.geminiModel || "_default",
        claudeModel: data.claudeModel || "_default",
        openaiModel: data.openaiModel || "_default",
      });
      setCustomInstructions(data.customInstructions || "");
    } catch (error) {
      toast.error("Failed to load settings");
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyChange(field: string, value: string) {
    setKeys((prev) => ({ ...prev, [field]: value }));
    setDirtyFields((prev) => new Set(prev).add(field));
  }

  function handleClearKey(field: string) {
    setKeys((prev) => ({ ...prev, [field]: "" }));
    setDirtyFields((prev) => new Set(prev).add(field));
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Build payload with only changed fields
      const payload: Record<string, string | null> = {
        preferredProvider,
        geminiModel: models.geminiModel === "_default" ? null : models.geminiModel,
        claudeModel: models.claudeModel === "_default" ? null : models.claudeModel,
        openaiModel: models.openaiModel === "_default" ? null : models.openaiModel,
        customInstructions: customInstructions.trim() || null,
      };

      for (const provider of PROVIDERS) {
        if (dirtyFields.has(provider.keyField)) {
          const val = keys[provider.keyField].trim();
          payload[provider.keyField] = val || null;
        }
      }

      const res = await fetch("/api/settings/keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save settings");
      }

      const data: KeyStatus = await res.json();
      setStatus(data);
      setPreferredProvider(data.preferredProvider);
      setModels({
        geminiModel: data.geminiModel || "_default",
        claudeModel: data.claudeModel || "_default",
        openaiModel: data.openaiModel || "_default",
      });
      setCustomInstructions(data.customInstructions || "");
      setKeys({ anthropicKey: "", openaiKey: "", geminiKey: "" });
      setDirtyFields(new Set());
      toast.success("Settings saved successfully");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save settings"
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-sm text-muted-foreground">
              Loading settings...
            </span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>AI Provider API Keys</CardTitle>
          <CardDescription>
            Configure API keys for the AI providers you want to use for
            extractions. Keys are encrypted before storage. You can also use the
            server&apos;s default Anthropic key if configured by the admin.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {PROVIDERS.map((provider) => {
            const hasKey = status?.[provider.hasField] ?? false;
            const isDirty = dirtyFields.has(provider.keyField);
            const currentValue = keys[provider.keyField];

            return (
              <div key={provider.id} className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor={provider.keyField} className="text-sm font-medium">
                    {provider.label}
                  </Label>
                  {hasKey && !isDirty ? (
                    <Badge variant="default" className="bg-green-600 hover:bg-green-600">
                      Configured
                    </Badge>
                  ) : isDirty && currentValue === "" && hasKey ? (
                    <Badge variant="destructive">Will be cleared</Badge>
                  ) : (
                    <Badge variant="secondary">Not set</Badge>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    id={provider.keyField}
                    type="password"
                    placeholder={
                      hasKey && !isDirty
                        ? "••••••••••••••••"
                        : provider.placeholder
                    }
                    value={currentValue}
                    onChange={(e) =>
                      handleKeyChange(provider.keyField, e.target.value)
                    }
                    disabled={saving}
                  />
                  {hasKey && !isDirty && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleClearKey(provider.keyField)}
                      disabled={saving}
                      className="shrink-0"
                    >
                      Clear
                    </Button>
                  )}
                </div>
                {/* Model selection */}
                <div className="flex items-center gap-2 mt-1">
                  <Label className="text-xs text-muted-foreground shrink-0">Model:</Label>
                  <Select
                    value={models[provider.modelField]}
                    onValueChange={(val) =>
                      setModels((prev) => ({ ...prev, [provider.modelField]: val }))
                    }
                    disabled={saving}
                  >
                    <SelectTrigger className="h-8 text-xs w-48">
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_OPTIONS[provider.id].map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Default Provider</CardTitle>
          <CardDescription>
            Choose which AI provider to use by default for new extractions. You
            can override this per extraction.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select
            value={preferredProvider}
            onValueChange={setPreferredProvider}
            disabled={saving}
          >
            <SelectTrigger className="w-full max-w-xs">
              <SelectValue placeholder="Select a provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
              <SelectItem value="openai">OpenAI (GPT-4o)</SelectItem>
              <SelectItem value="gemini">Google (Gemini)</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Custom Extraction Instructions</CardTitle>
          <CardDescription>
            Add custom instructions to guide the AI during extraction and
            verification. These are injected into every extraction prompt
            alongside the default instructions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="customInstructions">Instructions</Label>
            <Textarea
              id="customInstructions"
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              disabled={saving}
              maxLength={4000}
              rows={6}
              placeholder={`Examples of useful custom instructions:\n\n- Always name gate valves as "GV" instead of "GATE VALVE"\n- Our utility uses "SS" suffix for sanitary sewer instead of "WW"\n- Include bore & jack items when crossing roadways\n- Copper service lines under 10 ft should be excluded\n- Count each hydrant assembly as 1 unit including valve and tee`}
              className="min-h-[120px] resize-y"
            />
            <p className="text-xs text-muted-foreground text-right">
              {customInstructions.length} / 4,000 characters
            </p>
          </div>
        </CardContent>
      </Card>

      <Button
        onClick={handleSave}
        disabled={saving}
        size="lg"
        className="w-full sm:w-auto"
      >
        {saving ? "Saving..." : "Save Settings"}
      </Button>
    </div>
  );
}
