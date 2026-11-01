import { NextResponse } from "next/server";
import { requireSession } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { verificationResendEmail } from "@/lib/email/templates";
import { issueVerificationToken } from "@/lib/email-verification";
import { rateLimit } from "@/lib/rate-limit";

const MAX_RESENDS_PER_WINDOW = 3;
const WINDOW_MS = 60 * 60 * 1000;

export async function POST() {
  const auth = await requireSession();
  if (!auth.ok) return auth.response;

  const userId = auth.session.user.id;

  // Keyed by account rather than IP: the sender is authenticated, and the abuse
  // to prevent is mailbox flooding of one address.
  const limit = rateLimit(`verify-resend:${userId}`, MAX_RESENDS_PER_WINDOW, WINDOW_MS);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, emailVerifiedAt: true },
  });

  if (!user) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (user.emailVerifiedAt) {
    return NextResponse.json({ error: "This email is already confirmed" }, { status: 409 });
  }

  const token = await issueVerificationToken(user.id);
  const delivery = await sendEmail(
    verificationResendEmail({ name: user.name, email: user.email, token })
  );

  if (!delivery.sent) {
    return NextResponse.json({ error: delivery.reason }, { status: 502 });
  }

  return NextResponse.json({ sent: true });
}
