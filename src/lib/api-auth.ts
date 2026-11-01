import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Shared auth/ownership helpers for API routes.
 *
 * Every route under src/app/api/ that operates on a single user-owned record
 * used to repeat the same ~8-15 lines: check session, fetch the record,
 * compare `userId`, return an error response otherwise. Auditing all ~27
 * routes found this copy-pasted in ~19 of them with drifted status codes
 * and messages for the exact same "not yours" case — some routes used 404
 * "Not found", others 403 "Forbidden" or "Unauthorized" (occasionally with
 * the code and message mismatched, e.g. a 403 response saying
 * "Unauthorized"). These helpers standardize on 404 "Not found" for BOTH
 * "doesn't exist" and "exists but isn't yours" — deliberately not
 * distinguishing the two, so a request can't be used to probe whether some
 * other user's record id is valid.
 *
 * Usage in a route handler:
 *
 *   const result = await requireOwnedExtraction(id, { pdfData: true });
 *   if (!result.ok) return result.response;
 *   const { session, record: extraction } = result;
 *
 * Note: `select`'s merge with the ownership field (`userId`, or
 * `extraction: { select: { userId: true } }`) is cast through `unknown` —
 * Prisma's payload types are a deep conditional mapped type over the exact
 * `select` shape, which doesn't unify cleanly with a generic `S extends
 * ...Select` merged with an extra field inside a generic function. The
 * runtime behavior is straightforward (it's just an object spread); this
 * only routes around a TS inference limitation, not a real type hazard —
 * every call site still gets a fully-typed `record` back matching the
 * `select` it passed in.
 */

/**
 * The session shape after the `session?.user?.id` null-check — `user.id` is
 * narrowed to a plain `string` instead of `string | undefined`.
 *
 * Anchored to the augmented `Session` from src/types/next-auth.d.ts rather than
 * `ReturnType<typeof auth>`: `auth` is overloaded, and `ReturnType` resolves to
 * the wrong overload, which quietly reduced `user` to just `{ id: string }` and
 * dropped `role` and `mustChangePassword`.
 */
export type AuthedSession = Session & {
  user: { id: string };
};

export type AuthResult<T> =
  | { ok: true; response?: never; session: AuthedSession; record: T }
  | { ok: false; response: NextResponse; session?: never; record?: never };

type SessionResult =
  | { ok: true; session: AuthedSession }
  | { ok: false; response: NextResponse };

const unauthorized = () => NextResponse.json({ error: "Unauthorized" }, { status: 401 });
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/** Just the session check — for routes with no single owned record to look up (list/create endpoints, admin routes). */
export async function requireSession(): Promise<SessionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, response: unauthorized() };
  }
  return { ok: true, session: session as unknown as AuthedSession };
}

/** Extraction owned directly by `extraction.userId`. */
export async function requireOwnedExtraction<S extends Prisma.ExtractionSelect>(
  id: string,
  select: S
): Promise<AuthResult<Prisma.ExtractionGetPayload<{ select: S }>>> {
  const sessionResult = await requireSession();
  if (!sessionResult.ok) return sessionResult;

  const record = (await prisma.extraction.findUnique({
    where: { id },
    select: { ...select, userId: true } as unknown as Prisma.ExtractionSelect,
  })) as unknown as (Prisma.ExtractionGetPayload<{ select: S }> & { userId: string }) | null;

  if (!record || record.userId !== sessionResult.session.user.id) {
    return { ok: false, response: notFound() };
  }
  return { ok: true, session: sessionResult.session, record };
}

/**
 * Item owned via its parent Extraction (`item.extraction.userId`).
 *
 * `select` is optional — omit it to get the FULL item record back (via
 * `include` rather than `select`, since Prisma can't mix a narrowing
 * `select` with "everything"). Several routes need the whole record for
 * dynamic field access (e.g. the learning-system correction tracking in
 * `items/[id]` PATCH/DELETE), where naming every field individually would
 * just reintroduce the duplication this helper exists to remove.
 */
export async function requireOwnedItem(
  id: string
): Promise<AuthResult<Prisma.ItemGetPayload<{ include: { extraction: { select: { userId: true } } } }>>>;
export async function requireOwnedItem<S extends Prisma.ItemSelect>(
  id: string,
  select: S
): Promise<AuthResult<Prisma.ItemGetPayload<{ select: S }>>>;
export async function requireOwnedItem(
  id: string,
  select?: Prisma.ItemSelect
): Promise<AuthResult<Record<string, unknown>>> {
  const sessionResult = await requireSession();
  if (!sessionResult.ok) return sessionResult;

  const record = select
    ? ((await prisma.item.findUnique({
        where: { id },
        select: { ...select, extraction: { select: { userId: true } } } as unknown as Prisma.ItemSelect,
      })) as unknown as (Record<string, unknown> & { extraction: { userId: string } }) | null)
    : ((await prisma.item.findUnique({
        where: { id },
        include: { extraction: { select: { userId: true } } },
      })) as unknown as (Record<string, unknown> & { extraction: { userId: string } }) | null);

  if (!record || record.extraction.userId !== sessionResult.session.user.id) {
    return { ok: false, response: notFound() };
  }
  return { ok: true, session: sessionResult.session, record };
}

/** Measurement owned via its parent Extraction (`measurement.extraction.userId`) — omit `select` for the full record. */
export async function requireOwnedMeasurement(
  id: string
): Promise<AuthResult<Prisma.MeasurementGetPayload<{ include: { extraction: { select: { userId: true } } } }>>>;
export async function requireOwnedMeasurement<S extends Prisma.MeasurementSelect>(
  id: string,
  select: S
): Promise<AuthResult<Prisma.MeasurementGetPayload<{ select: S }>>>;
export async function requireOwnedMeasurement(
  id: string,
  select?: Prisma.MeasurementSelect
): Promise<AuthResult<Record<string, unknown>>> {
  const sessionResult = await requireSession();
  if (!sessionResult.ok) return sessionResult;

  const record = select
    ? ((await prisma.measurement.findUnique({
        where: { id },
        select: { ...select, extraction: { select: { userId: true } } } as unknown as Prisma.MeasurementSelect,
      })) as unknown as (Record<string, unknown> & { extraction: { userId: string } }) | null)
    : ((await prisma.measurement.findUnique({
        where: { id },
        include: { extraction: { select: { userId: true } } },
      })) as unknown as (Record<string, unknown> & { extraction: { userId: string } }) | null);

  if (!record || record.extraction.userId !== sessionResult.session.user.id) {
    return { ok: false, response: notFound() };
  }
  return { ok: true, session: sessionResult.session, record };
}

/** ReferenceExample owned directly by `referenceExample.userId` — omit `select` for the full record. */
export async function requireOwnedReferenceExample(
  id: string
): Promise<AuthResult<Prisma.ReferenceExampleGetPayload<object>>>;
export async function requireOwnedReferenceExample<S extends Prisma.ReferenceExampleSelect>(
  id: string,
  select: S
): Promise<AuthResult<Prisma.ReferenceExampleGetPayload<{ select: S }>>>;
export async function requireOwnedReferenceExample(
  id: string,
  select?: Prisma.ReferenceExampleSelect
): Promise<AuthResult<Record<string, unknown>>> {
  const sessionResult = await requireSession();
  if (!sessionResult.ok) return sessionResult;

  const record = select
    ? ((await prisma.referenceExample.findUnique({
        where: { id },
        select: { ...select, userId: true } as unknown as Prisma.ReferenceExampleSelect,
      })) as unknown as (Record<string, unknown> & { userId: string }) | null)
    : ((await prisma.referenceExample.findUnique({ where: { id } })) as unknown as
        | (Record<string, unknown> & { userId: string })
        | null);

  if (!record || record.userId !== sessionResult.session.user.id) {
    return { ok: false, response: notFound() };
  }
  return { ok: true, session: sessionResult.session, record };
}
