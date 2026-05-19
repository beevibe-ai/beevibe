"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type Entry =
  | { kind: "link"; href: string; label: string }
  | { kind: "disabled"; label: string };

const ENTRIES: Entry[] = [
  { kind: "link", href: "/memory", label: "All facts" },
  { kind: "link", href: "/promotions", label: "Promotions" },
  { kind: "disabled", label: "Merges" },
  { kind: "disabled", label: "Conflicts" },
];

export function MemorySubNav() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-1 mb-5 -mt-2 text-sm">
      {ENTRIES.map((entry) => {
        if (entry.kind === "disabled") {
          return (
            <button
              key={entry.label}
              type="button"
              disabled
              aria-disabled="true"
              title="Coming soon"
              className="px-3 py-1.5 rounded text-muted-foreground/50 cursor-not-allowed"
            >
              {entry.label}
            </button>
          );
        }
        const active = pathname === entry.href;
        return (
          <Link
            key={entry.href}
            href={entry.href}
            className={cn(
              "px-3 py-1.5 rounded",
              active
                ? "glassy-chip font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors",
            )}
          >
            {entry.label}
          </Link>
        );
      })}
    </div>
  );
}
