import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PlanExtract Pro as Admin",
  description: "Administration console for PlanExtract Pro",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
