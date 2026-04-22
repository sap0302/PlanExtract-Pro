// One-off bulk delete for the N oldest extractions.
//
// Usage:
//   node scripts/delete-old-extractions.mjs            # dry run (preview only)
//   node scripts/delete-old-extractions.mjs --execute  # actually delete
//
// Defaults to 100 extractions. Pass --count=N to change (e.g. --count=50).
//
// Cascade is handled by Prisma schema (onDelete: Cascade on Item/Correction/etc.
// via extractionId) — deleting an Extraction row automatically removes its
// children. No manual cleanup needed.

import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const countArg = args.find((a) => a.startsWith("--count="));
const COUNT = countArg ? parseInt(countArg.split("=")[1], 10) : 100;

if (!Number.isFinite(COUNT) || COUNT < 1) {
  console.error("Invalid --count value. Must be a positive integer.");
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const targets = await prisma.extraction.findMany({
    orderBy: { createdAt: "asc" },
    take: COUNT,
    select: {
      id: true,
      fileName: true,
      createdAt: true,
      userId: true,
      _count: { select: { items: true } },
    },
  });

  if (targets.length === 0) {
    console.log("No extractions found to delete.");
    process.exit(0);
  }

  const totalExtractions = await prisma.extraction.count();
  const totalItems = targets.reduce((sum, t) => sum + t._count.items, 0);

  console.log(
    `Found ${targets.length} oldest extractions (of ${totalExtractions} total):`
  );
  console.log("");
  for (const t of targets) {
    const dateStr = t.createdAt.toISOString().slice(0, 19).replace("T", " ");
    const nameShort = t.fileName.length > 50 ? t.fileName.slice(0, 47) + "..." : t.fileName;
    console.log(
      `  ${dateStr}  ${nameShort.padEnd(50)}  items: ${String(t._count.items).padStart(4)}`
    );
  }
  console.log("");
  console.log(
    `Summary: ${targets.length} extractions, ${totalItems} items (and their corrections)`
  );
  console.log(
    `Remaining after delete: ${totalExtractions - targets.length} extractions`
  );
  console.log("");

  if (!execute) {
    console.log(
      "DRY RUN — nothing deleted. Re-run with --execute to actually delete."
    );
    process.exit(0);
  }

  console.log("Deleting now...");
  const ids = targets.map((t) => t.id);
  const result = await prisma.extraction.deleteMany({
    where: { id: { in: ids } },
  });
  console.log(`Deleted ${result.count} extractions (cascaded items/corrections).`);
} catch (err) {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await prisma.$disconnect();
}
