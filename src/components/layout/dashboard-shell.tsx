"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "./sidebar";
import { Header } from "./header";

const STORAGE_KEY = "sidebar-collapsed";

/** Wraps the dashboard's Sidebar + Header + page content with a
 * collapse/expand toggle for the left nav — a small tab button attached to
 * the sidebar's edge, remembered across visits via localStorage. */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) === "true") setCollapsed(true);
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  };

  return (
    <div className="flex h-screen relative">
      {!collapsed && <Sidebar />}
      <button
        onClick={toggle}
        title={collapsed ? "Show sidebar" : "Hide sidebar"}
        className="hidden md:flex items-center justify-center absolute top-1/2 -translate-y-1/2 z-20
          w-4 h-10 rounded-r-md border border-l-0 bg-card text-muted-foreground
          hover:bg-muted hover:text-foreground transition-[left] duration-200"
        style={{ left: collapsed ? 0 : "16rem" /* matches Sidebar's w-64 */ }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={collapsed ? "" : "rotate-180"}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
