import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

try {
  const ex = await prisma.extraction.findFirst({
    orderBy: { createdAt: "desc" },
    include: {
      items: {
        orderBy: [{ measurementType: "asc" }, { system: "asc" }, { name: "asc" }],
      },
    },
  });

  if (!ex) {
    console.log("No extractions found.");
    process.exit(0);
  }

  console.log(`ID: ${ex.id}`);
  console.log(`Name: ${ex.name}`);
  console.log(`File: ${ex.fileName}  (${ex.pageCount ?? "?"} pages, ${(ex.fileSize / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Provider: ${ex.provider}`);
  console.log(`Status: ${ex.status}${ex.verified ? " (verified)" : ""}`);
  console.log(`Created: ${ex.createdAt.toISOString()}`);
  console.log(`Items: ${ex.items.length}`);
  console.log("");

  // Group by measurement type + system for readable comparison
  const groups = {};
  for (const it of ex.items) {
    const key = `${it.measurementType.toUpperCase()} / ${it.system}`;
    (groups[key] ??= []).push(it);
  }

  for (const [key, list] of Object.entries(groups).sort()) {
    console.log(`=== ${key} (${list.length} items) ===`);
    for (const it of list) {
      const qty = Number(it.quantity).toFixed(2);
      const method = it.quantityMethod ? ` [${it.quantityMethod}]` : "";
      const conf = ` (${it.confidence})`;
      const demo = it.isDemo ? " DEMO" : "";
      console.log(`  ${qty.padStart(10)} ${it.unit.padEnd(6)} ${it.name}${demo}${conf}${method}`);
    }
    console.log("");
  }
} finally {
  await prisma.$disconnect();
}
