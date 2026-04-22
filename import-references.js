// Imports reference examples from references.json into the current user's account
// Run with: node import-references.js <admin-email>
const { PrismaClient } = require("@prisma/client");
const fs = require("fs");

const prisma = new PrismaClient();

(async () => {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: node import-references.js <admin-email>");
    console.error("Example: node import-references.js admin@example.com");
    process.exit(1);
  }

  if (!fs.existsSync("references.json")) {
    console.error("references.json not found in current directory");
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`User not found: ${email}`);
    console.error("Available users:");
    const all = await prisma.user.findMany({ select: { email: true } });
    all.forEach((u) => console.error(`  - ${u.email}`));
    process.exit(1);
  }

  const refs = JSON.parse(fs.readFileSync("references.json", "utf8"));
  console.log(`Importing ${refs.length} reference examples for ${email}...`);

  let created = 0;
  let skipped = 0;
  for (const ref of refs) {
    const existing = await prisma.referenceExample.findFirst({
      where: { userId: user.id, name: ref.name },
    });
    if (existing) {
      console.log(`  ⊘ Skipped (already exists): ${ref.name}`);
      skipped++;
      continue;
    }
    await prisma.referenceExample.create({
      data: {
        name: ref.name,
        projectType: ref.projectType,
        rawText: ref.rawText,
        isActive: ref.isActive ?? true,
        userId: user.id,
      },
    });
    console.log(`  ✓ Imported: ${ref.name}`);
    created++;
  }

  console.log("");
  console.log(`Done! Created ${created}, skipped ${skipped} (already existed).`);
  await prisma.$disconnect();
})();
