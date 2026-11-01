import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { serviceFetch } from "@/lib/api";
import type { AdminUser, RequestStatus, SignupRequestsPayload } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { RequestsPanel } from "@/components/requests-panel";
import { UsersPanel } from "@/components/users-panel";

const STATUSES: RequestStatus[] = ["pending", "approved", "rejected"];

function isStatus(value: string | undefined): value is RequestStatus {
  return value !== undefined && (STATUSES as string[]).includes(value);
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.email) redirect("/login");

  const actor = session.user.email;
  const { status } = await searchParams;
  const filter: RequestStatus = isStatus(status) ? status : "pending";

  const [requestsResult, usersResult] = await Promise.all([
    serviceFetch<SignupRequestsPayload>(
      `/api/internal/admin/signup-requests?status=${filter}`,
      actor
    ),
    serviceFetch<{ users: AdminUser[] }>("/api/internal/admin/users", actor),
  ]);

  const connectionError = !requestsResult.ok
    ? requestsResult.error
    : !usersResult.ok
      ? usersResult.error
      : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">PlanExtract Pro Admin</h1>
          <p className="text-xs text-muted-foreground">Signed in as {actor}</p>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <Button type="submit" variant="outline" size="sm">
            Sign out
          </Button>
        </form>
      </header>

      {connectionError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {connectionError}
        </div>
      )}

      {requestsResult.ok && (
        <RequestsPanel
          requests={requestsResult.data.requests}
          counts={requestsResult.data.counts}
          emailConfigured={requestsResult.data.emailConfigured}
          filter={filter}
        />
      )}

      {usersResult.ok && <UsersPanel users={usersResult.data.users} />}
    </div>
  );
}
