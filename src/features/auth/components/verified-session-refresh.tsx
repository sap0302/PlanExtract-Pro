"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

/**
 * Clears the verification gate for someone who was already signed in when they
 * followed the link. Their JWT still says unverified, so without refreshing it
 * the dashboard would bounce them straight back here.
 */
export function VerifiedSessionRefresh() {
  const { data: session, status, update } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status !== "authenticated" || session?.user?.emailConfirmed) return;

    let cancelled = false;
    (async () => {
      await update({ emailConfirmed: true });
      if (!cancelled) router.push("/dashboard");
    })();

    return () => {
      cancelled = true;
    };
  }, [status, session?.user?.emailConfirmed, update, router]);

  return null;
}
