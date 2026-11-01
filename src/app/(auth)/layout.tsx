import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (session && !session.user.mustChangePassword) {
    redirect("/dashboard");
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-muted/40 p-4">
      <div className="w-full max-w-md">{children}</div>
      <p className="mt-6 text-[11px] text-muted-foreground/60">
        &copy; 2025&ndash;2026 Serdar Piriyev. Built for Steppe &amp; Stone.
      </p>
    </div>
  );
}
