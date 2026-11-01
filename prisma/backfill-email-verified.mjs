// One-off backfill for the emailVerifiedAt column.
//
// Every account that existed before email verification was introduced predates
// the requirement, so it is marked verified rather than being locked out of the
// app. Safe to re-run: it only touches rows that are still null.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const { count } = await prisma.user.updateMany({
    where: { emailVerifiedAt: null },
    data: { emailVerifiedAt: new Date() },
  });
  console.log(`Marked ${count} pre-existing account(s) as verified.`);
} finally {
  await prisma.$disconnect();
}
