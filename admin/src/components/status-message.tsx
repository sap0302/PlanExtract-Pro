import { cn } from "@/lib/utils";
import type { ActionResult } from "@/app/actions";

export function StatusMessage({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  // Routine successes say nothing — the refreshed list is the confirmation.
  if (result.ok && !result.message) return null;

  return (
    <p
      className={cn(
        "rounded-md p-2.5 text-xs",
        result.ok ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive"
      )}
    >
      {result.ok ? result.message : result.error}
    </p>
  );
}
