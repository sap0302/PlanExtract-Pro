import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isEmailConfigured } from "@/lib/email";
import { requireServiceToken } from "@/lib/service-auth";

const STATUSES = ["pending", "approved", "rejected"] as const;

// passwordHash is deliberately absent — no admin view ever needs it.
const requestFields = {
  id: true,
  name: true,
  email: true,
  company: true,
  note: true,
  status: true,
  reviewNote: true,
  reviewedAt: true,
  reviewedById: true,
  createdAt: true,
} as const;

export async function GET(req: Request) {
  const auth = requireServiceToken(req);
  if (!auth.ok) return auth.response;

  const status = new URL(req.url).searchParams.get("status") ?? "pending";
  if (status !== "all" && !(STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
  }

  const [requests, grouped] = await Promise.all([
    prisma.signupRequest.findMany({
      where: status === "all" ? undefined : { status },
      select: requestFields,
      orderBy: { createdAt: "desc" },
    }),
    prisma.signupRequest.groupBy({ by: ["status"], _count: true }),
  ]);

  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<
    (typeof STATUSES)[number],
    number
  >;
  for (const row of grouped) {
    if ((STATUSES as readonly string[]).includes(row.status)) {
      counts[row.status as (typeof STATUSES)[number]] = row._count;
    }
  }

  return NextResponse.json({ requests, counts, emailConfigured: isEmailConfigured() });
}
