import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export async function GET() {
  try {
    // Test 1: Can we connect to the database?
    const userCount = await prisma.user.count();

    // Test 2: Can we find the admin user?
    const user = await prisma.user.findUnique({
      where: { email: "serg22408@gmail.com" },
      select: { id: true, email: true, role: true, passwordHash: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found", userCount });
    }

    // Test 3: Does bcrypt work?
    const match = await bcrypt.compare("Test1234", user.passwordHash);

    return NextResponse.json({
      dbConnected: true,
      userCount,
      userFound: true,
      email: user.email,
      role: user.role,
      hashPrefix: user.passwordHash.substring(0, 10),
      passwordMatch: match,
      authSecret: !!process.env.AUTH_SECRET,
      nextauthSecret: !!process.env.NEXTAUTH_SECRET,
      databaseUrl: process.env.DATABASE_URL?.substring(0, 30) + "...",
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Unknown error",
    }, { status: 500 });
  }
}
