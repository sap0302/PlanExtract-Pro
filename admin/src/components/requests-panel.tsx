"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { approveRequest, rejectRequest, removeRequest, type ActionResult } from "@/app/actions";
import type { RequestStatus, SignupRequest } from "@/lib/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusMessage } from "@/components/status-message";
import { cn } from "@/lib/utils";

const FILTERS: { value: RequestStatus; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

export function RequestsPanel({
  requests,
  counts,
  emailConfigured,
  filter,
}: {
  requests: SignupRequest[];
  counts: Record<RequestStatus, number>;
  emailConfigured: boolean;
  filter: RequestStatus;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  function perform(work: () => Promise<ActionResult>) {
    startTransition(async () => {
      const actionResult = await work();
      setResult(actionResult);
      if (actionResult.ok) {
        setRejectingId(null);
        setRejectReason("");
        router.refresh();
      }
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <CardTitle>
          Access Requests
          {counts.pending > 0 && (
            <span className="ml-2 rounded-full bg-primary px-1.5 py-0.5 align-middle text-[10px] font-medium text-primary-foreground">
              {counts.pending} PENDING
            </span>
          )}
        </CardTitle>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <Link
              key={f.value}
              href={`/?status=${f.value}`}
              className={cn(
                buttonVariants({ variant: filter === f.value ? "default" : "outline", size: "xs" })
              )}
            >
              {f.label} ({counts[f.value]})
            </Link>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!emailConfigured && (
          <p className="rounded-md bg-muted p-2.5 text-xs text-muted-foreground">
            SMTP is not configured on the main app, so approved applicants won&apos;t receive the
            confirmation link they need to activate their account.
          </p>
        )}

        <StatusMessage result={result} />

        {requests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No {filter} requests.</p>
        ) : (
          requests.map((request) => (
            <div key={request.id} className="space-y-2 rounded-lg border bg-muted/20 p-3">
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {request.name}
                    {request.company && (
                      <span className="font-normal text-muted-foreground"> · {request.company}</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {request.email} · Requested {new Date(request.createdAt).toLocaleDateString()}
                  </div>
                  {request.note && (
                    <p className="mt-1.5 whitespace-pre-wrap border-l-2 pl-2 text-xs text-muted-foreground">
                      {request.note}
                    </p>
                  )}
                  {request.status !== "pending" && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Reviewed by {request.reviewedById ?? "unknown"}
                      {request.reviewNote ? ` — ${request.reviewNote}` : ""}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {request.status === "pending" ? (
                    <>
                      <Button
                        size="xs"
                        disabled={pending}
                        onClick={() => perform(() => approveRequest(request.id))}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={pending}
                        onClick={() => {
                          setRejectingId(rejectingId === request.id ? null : request.id);
                          setRejectReason("");
                        }}
                      >
                        Reject
                      </Button>
                    </>
                  ) : (
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending}
                      onClick={() => perform(() => removeRequest(request.id))}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>

              {rejectingId === request.id && (
                <div className="flex items-center gap-1">
                  <Input
                    className="h-7 text-xs"
                    placeholder="Reason (optional, kept internal)"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    maxLength={1000}
                    autoFocus
                  />
                  <Button
                    size="xs"
                    disabled={pending}
                    onClick={() => perform(() => rejectRequest(request.id, rejectReason))}
                  >
                    Confirm reject
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => setRejectingId(null)}>
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
