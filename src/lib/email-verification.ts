import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/**
 * Single-use email verification tokens.
 *
 * The raw token only ever exists in the emailed link; the database holds its
 * SHA-256. Plain hashing is enough here (unlike passwords) because the token is
 * 256 bits of randomness, so there is nothing to brute-force.
 */

const TOKEN_BYTES = 32;
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issues a fresh token, invalidating any earlier unused ones for the same user
 * so a resend leaves exactly one working link.
 *
 * Accepts a transaction client so issuing can share the caller's transaction.
 */
export async function issueVerificationToken(
  userId: string,
  client: Prisma.TransactionClient | typeof prisma = prisma
): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString("hex");

  await client.emailVerificationToken.deleteMany({
    where: { userId, consumedAt: null },
  });

  await client.emailVerificationToken.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
    },
  });

  return token;
}

export type VerificationOutcome =
  | { status: "verified"; email: string }
  | { status: "already_verified"; email: string }
  | { status: "expired" }
  | { status: "invalid" };

export async function consumeVerificationToken(token: string): Promise<VerificationOutcome> {
  if (!token) return { status: "invalid" };

  const record = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, email: true, emailVerifiedAt: true } } },
  });

  if (!record) return { status: "invalid" };

  // A consumed token on an already-verified account is almost always the user
  // opening the same link twice, so it reads as success rather than an error.
  if (record.consumedAt) {
    return record.user.emailVerifiedAt
      ? { status: "already_verified", email: record.user.email }
      : { status: "invalid" };
  }

  if (record.expiresAt.getTime() <= Date.now()) return { status: "expired" };

  if (record.user.emailVerifiedAt) {
    return { status: "already_verified", email: record.user.email };
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: record.userId },
      data: { emailVerifiedAt: new Date() },
    }),
    prisma.emailVerificationToken.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    }),
  ]);

  return { status: "verified", email: record.user.email };
}
