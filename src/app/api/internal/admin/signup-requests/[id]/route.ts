import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { accountApprovedEmail } from "@/lib/email/templates";
import { issueVerificationToken } from "@/lib/email-verification";
import { requireServiceToken } from "@/lib/service-auth";
import { signupReviewSchema } from "@/lib/validators";

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

  const parsed = signupReviewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid data", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { action, reviewNote } = parsed.data;

  const request = await prisma.signupRequest.findUnique({ where: { id } });
  if (!request) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  if (request.status !== "pending") {
    return NextResponse.json(
      { error: `This request was already ${request.status}` },
      { status: 409 }
    );
  }

  const review = {
    reviewedAt: new Date(),
    reviewedById: auth.caller.actor,
    reviewNote: reviewNote ?? null,
  };

  if (action === "reject") {
    await prisma.signupRequest.update({
      where: { id },
      data: {
        ...review,
        status: "rejected",
        // The applicant must re-apply to be reconsidered, so keeping their
        // password hash on file serves no purpose.
        passwordHash: "",
      },
    });
    return NextResponse.json({ status: "rejected" });
  }

  try {
    const { user, token } = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          name: request.name,
          email: request.email,
          passwordHash: request.passwordHash,
          role: "user",
          // The applicant chose this password themselves, so there is nothing
          // to rotate on first login.
          mustChangePassword: false,
          // Stays unverified until they follow the emailed link, which is what
          // proves the address they signed up with is really theirs.
          emailVerifiedAt: null,
        },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
      });

      await tx.signupRequest.update({
        where: { id },
        data: { ...review, status: "approved", passwordHash: "" },
      });

      return { user: created, token: await issueVerificationToken(created.id, tx) };
    });

    // Sent after the transaction commits: the account exists either way, so a
    // mail failure is reported to the admin rather than failing the approval.
    const delivery = await sendEmail(
      accountApprovedEmail({ name: user.name, email: user.email, token })
    );

    return NextResponse.json({
      status: "approved",
      user,
      emailSent: delivery.sent,
      emailError: delivery.sent ? undefined : delivery.reason,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "Could not approve this request" }, { status: 500 });
  }
}

/** Clears a reviewed request out of the admin list. Pending requests must be approved or rejected first. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireServiceToken(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;

  const request = await prisma.signupRequest.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!request) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }
  if (request.status === "pending") {
    return NextResponse.json(
      { error: "Review this request before removing it" },
      { status: 409 }
    );
  }

  await prisma.signupRequest.delete({ where: { id } });
  return new NextResponse(null, { status: 204 });
}
