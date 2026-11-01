"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createUser, deleteUser, resetPassword, type ActionResult } from "@/app/actions";
import type { AdminUser } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusMessage } from "@/components/status-message";

export function UsersPanel({ users }: { users: AdminUser[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function perform(work: () => Promise<ActionResult>, onSuccess?: () => void) {
    startTransition(async () => {
      const actionResult = await work();
      setResult(actionResult);
      if (actionResult.ok) {
        onSuccess?.();
        router.refresh();
      }
    });
  }

  function onCreate(e: React.FormEvent) {
    e.preventDefault();
    perform(
      () => createUser({ name, email, password }),
      () => {
        setName("");
        setEmail("");
        setPassword("");
      }
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Users ({users.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <StatusMessage result={result} />

        <form onSubmit={onCreate} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="new-name" className="text-xs">
              Name
            </Label>
            <Input
              id="new-name"
              className="w-44"
              placeholder="John Smith"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-email" className="text-xs">
              Email
            </Label>
            <Input
              id="new-email"
              type="email"
              className="w-56"
              placeholder="john@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-password" className="text-xs">
              Temporary Password
            </Label>
            <Input
              id="new-password"
              type="text"
              className="w-40"
              placeholder="min 8 chars"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Working..." : "Create User"}
          </Button>
        </form>

        <div className="space-y-3">
          {users.map((user) => (
            <div
              key={user.id}
              className="flex items-center gap-4 rounded-lg border bg-muted/20 p-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{user.name || "Unnamed"}</span>
                  {user.role === "admin" && (
                    <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                      ADMIN
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {user.email} · {user._count.extractions} extractions · Joined{" "}
                  {new Date(user.createdAt).toLocaleDateString()}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {resetUserId === user.id ? (
                  <>
                    <Input
                      type="text"
                      className="h-7 w-32 text-xs"
                      placeholder="New password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoFocus
                    />
                    <Button
                      size="xs"
                      disabled={pending}
                      onClick={() =>
                        perform(
                          () => resetPassword(user.id, newPassword),
                          () => {
                            setResetUserId(null);
                            setNewPassword("");
                          }
                        )
                      }
                    >
                      Save
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setResetUserId(null);
                        setNewPassword("");
                      }}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="xs"
                      onClick={() => setResetUserId(user.id)}
                    >
                      Reset Password
                    </Button>
                    {user.role !== "admin" &&
                      (confirmDeleteId === user.id ? (
                        <>
                          <Button
                            variant="destructive"
                            size="xs"
                            disabled={pending}
                            onClick={() =>
                              perform(
                                () => deleteUser(user.id),
                                () => setConfirmDeleteId(null)
                              )
                            }
                          >
                            Delete {user._count.extractions} extractions
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="outline"
                          size="xs"
                          className="text-destructive"
                          onClick={() => setConfirmDeleteId(user.id)}
                        >
                          Delete
                        </Button>
                      ))}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
