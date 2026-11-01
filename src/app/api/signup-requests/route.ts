import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { signupRequestSchema } from "@/lib/validators";

const MAX_REQUESTS_PER_WINDOW = 5;
const WINDOW_MS = 60 * 60 * 1000;

// Every outcome returns this so the endpoint can't be used to discover which
// emails already have an account or a pending request.
const ACCEPTED = {
  message: "Your request has been submitted. An administrator will review it shortly.",
};

const accepted = () => NextResponse.json(ACCEPTED, { status: 202 });

export async function POST(req: Request) {
  const limit = rateLimit(clientKey(req, "signup-request"), MAX_REQUESTS_PER_WINDOW, WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsed = signupRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid data", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { name, password, company, note } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();

  // Hashed before any lookup so the response time doesn't reveal whether the
  // request short-circuited on an existing account.
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser) return accepted();

    const existingRequest = await prisma.signupRequest.findUnique({
      where: { email },
      select: { status: true },
    });
    if (existingRequest?.status === "approved") return accepted();

    // Re-submitting replaces the previous attempt, which also lets someone
    // rejected for a fixable reason apply again with corrected details.
    await prisma.signupRequest.upsert({
      where: { email },
      create: { name, email, passwordHash, company, note },
      update: {
        name,
        passwordHash,
        company: company ?? null,
        note: note ?? null,
        status: "pending",
        reviewedAt: null,
        reviewedById: null,
        reviewNote: null,
      },
    });

    return accepted();
  } catch {
    return NextResponse.json(
      { error: "Could not submit your request. Please try again." },
      { status: 500 }
    );
  }
}
