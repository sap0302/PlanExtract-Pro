"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/auth";
import { serviceFetch } from "@/lib/api";

/**
 * A successful action only carries a message when the outcome isn't already
 * obvious from the refreshed page — a failed email, or a change with nothing
 * visible behind it. Everything else stays quiet.
 */
export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/**
 * Every action re-checks the session on the server. Server actions are
 * reachable as POST endpoints, so a session check in the page is not enough.
 */
async function currentActor(): Promise<string | null> {
  const session = await auth();
  return session?.user?.email ?? null;
}

async function run(
  work: (actor: string) => Promise<ActionResult>
): Promise<ActionResult> {
  const actor = await currentActor();
  if (!actor) return { ok: false, error: "Your session expired — sign in again" };

  const result = await work(actor);
  if (result.ok) revalidatePath("/");
  return result;
}

const idSchema = z.string().min(1, "Missing id");

export async function approveRequest(id: string): Promise<ActionResult> {
  return run(async (actor) => {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) return { ok: false, error: "Missing request id" };

    const res = await serviceFetch<{ emailSent: boolean; emailError?: string }>(
      `/api/internal/admin/signup-requests/${parsed.data}`,
      actor,
      { method: "PATCH", body: { action: "approve" } }
    );
    if (!res.ok) return { ok: false, error: res.error };

    if (res.data.emailSent) return { ok: true };

    // The account exists but can't be used until the link is followed, so a
    // delivery failure needs to be visible rather than silently swallowed.
    return {
      ok: true,
      message: res.data.emailError
        ? `Approved, but the confirmation email failed: ${res.data.emailError}. The applicant can request a new link after signing in.`
        : "Approved, but no confirmation email was sent. The applicant can request a new link after signing in.",
    };
  });
}

export async function rejectRequest(id: string, reviewNote: string): Promise<ActionResult> {
  return run(async (actor) => {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) return { ok: false, error: "Missing request id" };

    const res = await serviceFetch(
      `/api/internal/admin/signup-requests/${parsed.data}`,
      actor,
      {
        method: "PATCH",
        body: { action: "reject", reviewNote: reviewNote.trim() || undefined },
      }
    );
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true };
  });
}

export async function removeRequest(id: string): Promise<ActionResult> {
  return run(async (actor) => {
    const res = await serviceFetch(`/api/internal/admin/signup-requests/${id}`, actor, {
      method: "DELETE",
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true };
  });
}

const createUserSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function createUser(input: {
  name: string;
  email: string;
  password: string;
}): Promise<ActionResult> {
  return run(async (actor) => {
    const parsed = createUserSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid data" };
    }

    const res = await serviceFetch("/api/internal/admin/users", actor, {
      method: "POST",
      body: parsed.data,
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true };
  });
}

export async function resetPassword(id: string, password: string): Promise<ActionResult> {
  return run(async (actor) => {
    if (password.length < 8) {
      return { ok: false, error: "Password must be at least 8 characters" };
    }

    const res = await serviceFetch(`/api/internal/admin/users/${id}`, actor, {
      method: "PATCH",
      body: { password },
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, message: "Password reset — the user must change it at next sign-in" };
  });
}

export async function deleteUser(id: string): Promise<ActionResult> {
  return run(async (actor) => {
    const res = await serviceFetch(`/api/internal/admin/users/${id}`, actor, {
      method: "DELETE",
    });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true };
  });
}
