import { redirect } from "next/navigation";
import { adminConfigError, auth } from "@/auth";
import { LoginForm } from "@/components/login-form";

export default async function LoginPage() {
  if (await auth()) redirect("/");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-sm">
        <LoginForm configError={adminConfigError()} />
      </div>
      <p className="mt-6 text-[11px] text-muted-foreground/60">
        &copy; 2025&ndash;2026 Serdar Piriyev. Built for Steppe &amp; Stone.
      </p>
    </div>
  );
}
