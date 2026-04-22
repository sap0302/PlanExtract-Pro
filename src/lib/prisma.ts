import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  transactionOptions: {
    maxWait: 30000,  // 30s max wait to acquire transaction
    timeout: 120000, // 2 min transaction timeout (large PDFs + many items)
  },
});

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
