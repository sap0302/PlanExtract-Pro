import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireServiceToken } from "@/lib/service-auth";

const updateUserSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireServiceToken(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = updateUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid data", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const { name, email, password } = parsed.data;
  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (email !== undefined) data.email = email.trim().toLowerCase();
  if (password !== undefined) {
    data.passwordHash = await bcrypt.hash(password, 12);
    data.mustChangePassword = true;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  try {
    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    });
    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { error: "Could not update this user" },
      { status: 409 }
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireServiceToken(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, email: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // The service token has no "self" to protect, so admin accounts are guarded
  // here instead — deleting one cascades away all of its extractions.
  if (user.role === "admin") {
    return NextResponse.json(
      { error: "Admin accounts cannot be deleted through this API" },
      { status: 403 }
    );
  }

  // The approved request and the account describe the same person, so the
  // request goes with it — otherwise the admin's approved list keeps advertising
  // an account that no longer exists. Pending and rejected rows survive: a
  // pending one is a fresh application, and a rejected one is an audit record.
  const [, requests] = await prisma.$transaction([
    prisma.user.delete({ where: { id } }),
    prisma.signupRequest.deleteMany({ where: { email: user.email, status: "approved" } }),
  ]);

  return NextResponse.json({ requestsRemoved: requests.count });
}
