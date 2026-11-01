import { createSmtpTransport, readSmtpConfig } from "./smtp";
import type { EmailMessage, EmailTransport, SendResult } from "./types";

export type { EmailMessage, EmailTransport, SendResult };

// `undefined` = not resolved yet, `null` = resolved and unconfigured.
let cachedTransport: EmailTransport | null | undefined;

function resolveTransport(): EmailTransport | null {
  if (cachedTransport === undefined) {
    const config = readSmtpConfig();
    cachedTransport = config ? createSmtpTransport(config) : null;
  }
  return cachedTransport;
}

export function isEmailConfigured(): boolean {
  return resolveTransport() !== null;
}

/**
 * Best-effort delivery: never throws, so a mail outage can't roll back the
 * action that triggered the notification. Callers decide what to tell the user
 * based on the returned result.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  const transport = resolveTransport();
  if (!transport) {
    return { sent: false, reason: "Email delivery is not configured" };
  }

  try {
    await transport.send(message);
    return { sent: true };
  } catch (err) {
    return {
      sent: false,
      reason: err instanceof Error ? err.message : "Unknown email delivery error",
    };
  }
}
