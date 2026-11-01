import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * Machine-to-machine auth for /api/internal/*.
 *
 * These routes act across every user's data with no session behind them, so
 * they are gated by a shared secret held only by the admin app's server. The
 * secret must never reach a browser: the admin app calls these endpoints from
 * its own server, not from admin client components.
 */

export type ServiceCaller = {
  /** Identifies the human behind the call, recorded on anything auditable. */
  actor: string;
};

export type ServiceAuthResult =
  | { ok: true; caller: ServiceCaller; response?: never }
  | { ok: false; caller?: never; response: NextResponse };

const MIN_TOKEN_LENGTH = 32;

function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function requireServiceToken(req: Request): ServiceAuthResult {
  const expected = process.env.ADMIN_SERVICE_TOKEN;

  // Fails closed — a missing or weak secret must never be read as "open access".
  if (!expected || expected.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Service authentication is not configured" },
        { status: 503 }
      ),
    };
  }

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!presented || !constantTimeEquals(presented, expected)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }

  const actor = req.headers.get("x-admin-actor")?.trim();
  if (!actor) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Missing x-admin-actor header" },
        { status: 400 }
      ),
    };
  }

  return { ok: true, caller: { actor } };
}
