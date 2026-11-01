"use client";

import { signOut } from "next-auth/react";
import type { VariantProps } from "class-variance-authority";
import { Button, buttonVariants } from "@/components/ui/button";

/** Ends the session and lands on the login page. */
export function SignOutButton({
  children = "Sign out",
  variant = "outline",
  className,
}: {
  children?: React.ReactNode;
  variant?: VariantProps<typeof buttonVariants>["variant"];
  className?: string;
}) {
  return (
    <Button variant={variant} className={className} onClick={() => signOut({ callbackUrl: "/login" })}>
      {children}
    </Button>
  );
}
