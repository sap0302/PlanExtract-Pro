import { ApiKeySettings } from "@/features/settings";

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground mt-1">
          Manage your AI provider API keys, preferences, and custom extraction instructions.
        </p>
      </div>
      <ApiKeySettings />
    </div>
  );
}
