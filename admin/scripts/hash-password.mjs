import bcrypt from "bcryptjs";

const password = process.argv[2];

if (!password || password.length < 8) {
  console.error('Usage: node scripts/hash-password.mjs "your-password"  (min 8 characters)');
  process.exit(1);
}

console.log(await bcrypt.hash(password, 12));
