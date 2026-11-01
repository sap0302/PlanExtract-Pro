"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function ResendVerification({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  async function onResend() {
    setError("");
    setState("sending");

    try {
      const res = await fetch("/api/verify-email/resend", { method: "POST" });
      const data = await res.json().catch(() => null);

      if (!res.ok) throw new Error(data?.error || "Could not send the email");

      setState("sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <p className="rounded-md bg-muted p-3 text-center text-sm text-muted-foreground">
        A new confirmation link is on its way to {email}.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {error && (
        <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      )}
      <Button className="w-full" onClick={onResend} disabled={state === "sending"}>
        {state === "sending" ? "Sending..." : "Send a new link"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">Sending to {email}</p>
    </div>
  );
}
