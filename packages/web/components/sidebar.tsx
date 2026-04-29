"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CircleDot,
  Home,
  ListChecks,
  MessageSquare,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";
import { UserWidget } from "./user-widget";

type NavEntry = {
  href: string;
  label: string;
  icon: LucideIcon;
  isActive: (pathname: string) => boolean;
};

const NAV: NavEntry[] = [
  { href: "/", label: "Home", icon: Home, isActive: (p) => p === "/" },
  {
    href: "/tasks",
    label: "Tasks",
    icon: ListChecks,
    isActive: (p) => p.startsWith("/tasks"),
  },
  {
    href: "/agents",
    label: "Agents",
    icon: CircleDot,
    isActive: (p) => p.startsWith("/agents"),
  },
  {
    href: "/threads",
    label: "Threads",
    icon: MessageSquare,
    isActive: (p) => p.startsWith("/threads"),
  },
  {
    href: "/memory",
    label: "Memory",
    icon: Sparkles,
    isActive: (p) => p.startsWith("/memory") || p.startsWith("/promotions"),
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-[220px] shrink-0 bg-card flex flex-col">
      <div className="h-14 flex items-center gap-2.5 px-4">
        <div className="h-6 w-6 rounded bg-primary flex items-center justify-center">
          <span className="text-primary-foreground text-sm font-bold leading-none">
            b
          </span>
        </div>
        <span className="font-semibold tracking-tight">beevibe</span>
      </div>

      <nav className="flex-1 p-2 space-y-0.5 text-sm">
        {NAV.map(({ href, label, icon: Icon, isActive }) => {
          const active = isActive(pathname);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded transition-colors duration-150",
                active
                  ? "bg-secondary text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary",
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="p-3">
        <div className="flex items-center gap-1">
          <UserWidget />
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
