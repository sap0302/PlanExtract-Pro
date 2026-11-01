import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { consumeVerificationToken } from "@/lib/email-verification";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ResendVerification, SignOutButton, VerifiedSessionRefresh } from "@/features/auth";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const outcome = token ? await consumeVerificationToken(token) : null;
  const session = await auth();

  // Nothing to do here once the address is confirmed and the session knows it.
  if (!outcome && session?.user?.emailConfirmed) redirect("/dashboard");

  const succeeded = outcome?.status === "verified" || outcome?.status === "already_verified";
  // A signed-in visitor can't use the login page (it forwards sessions to the
  // dashboard, which forwards unverified ones back here), so offer sign-out.
  const showSignOut = !succeeded && !!session;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader className="text-center space-y-3">
            <div className="flex justify-center">
              <Image
                src="/steppe-stone-logo.svg"
                alt="Steppe &amp; Stone"
                width={56}
                height={56}
                className="dark:invert"
              />
            </div>
            <CardTitle className="text-xl">
              {succeeded
                ? "Email confirmed"
                : outcome?.status === "expired"
                  ? "This link has expired"
                  : outcome?.status === "invalid"
                    ? "This link isn't valid"
                    : "Confirm your email"}
            </CardTitle>
            <CardDescription>
              {succeeded
                ? "Your account is active. You can sign in now."
                : outcome?.status === "expired"
                  ? "Verification links are valid for a limited time. Request a new one below."
                  : outcome?.status === "invalid"
                    ? "The link may have already been used, or it was copied incompletely."
                    : "We sent a confirmation link to your email address. Open it on any device, then refresh this page."}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-3">
            {succeeded && <VerifiedSessionRefresh />}

            {!succeeded && session?.user?.email && (
              <ResendVerification email={session.user.email} />
            )}

            {!succeeded && !session && (
              <p className="text-center text-sm text-muted-foreground">
                Sign in to request a new confirmation link.
              </p>
            )}
          </CardContent>

          <CardFooter>
            {showSignOut ? (
              <SignOutButton className="w-full">Sign out</SignOutButton>
            ) : (
              <Button asChild variant={succeeded ? "default" : "outline"} className="w-full">
                <Link href="/login">{succeeded ? "Sign in" : "Back to sign in"}</Link>
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
      <p className="mt-6 text-[11px] text-muted-foreground/60">
        &copy; 2025&ndash;2026 Serdar Piriyev. Built for Steppe &amp; Stone.
      </p>
    </div>
  );
}
