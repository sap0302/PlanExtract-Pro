// Exports all active reference examples to references.json
// Run with: node export-references.js
const { PrismaClient } = require("@prisma/client");
const fs = require("fs");

const prisma = new PrismaClient();

(async () => {
  const refs = await prisma.referenceExample.findMany({
    where: { isActive: true },
    select: {
      name: true,
      projectType: true,
      rawText: true,
      isActive: true,
    },
    orderBy: { createdAt: "asc" },
  });

  fs.writeFileSync("references.json", JSON.stringify(refs, null, 2));
  console.log(`Exported ${refs.length} reference examples to references.json`);
  refs.forEach((r, i) => console.log(`  ${i + 1}. ${r.name} (${r.projectType})`));

  await prisma.$disconnect();
})();
