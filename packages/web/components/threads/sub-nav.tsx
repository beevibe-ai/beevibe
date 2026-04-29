"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ENTRIES: { href: string; label: string }[] = [
  { href: "/threads", label: "Channels" },
  { href: "/mesh", label: "Mesh" },
  { href: "/threads/dms", label: "DMs" },
];

export function ThreadsSubNav() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 mb-6 -mt-2 text-sm">
      {ENTRIES.map(({ href, label }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "px-3 py-1.5 rounded transition-colors",
              active
                ? "bg-secondary text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary",
            )}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}
