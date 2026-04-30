"use client";

import { Info, Layers } from "lucide-react";
import type { MemoryScope } from "@beevibe/core";
import { cn } from "@/lib/utils";

export type ScopeFilter = "all" | MemoryScope;

interface Counts {
  total: number;
  ic: number;
  team: number;
  org: number;
}

interface Props {
  current: ScopeFilter;
  counts: Counts;
  onChange: (next: ScopeFilter) => void;
}

const SCOPE_TABS: { key: ScopeFilter; chip?: { label: MemoryScope; class: string }; label: string }[] = [
  { key: "all", label: "All scopes" },
  { key: "ic", chip: { label: "ic", class: "bg-hier-ic/15 text-hier-ic" }, label: "Mine" },
  { key: "team", chip: { label: "team", class: "bg-hier-team/10 text-hier-team" }, label: "Team" },
  { key: "org", chip: { label: "org", class: "border border-hier-org text-hier-org" }, label: "Org" },
];

export function ScopeTabs({ current, counts, onChange }: Props) {
  return (
    <div className="flex items-center gap-1.5 mb-4 text-xs">
      <span className="text-muted-foreground mr-1">View:</span>
      {SCOPE_TABS.map((t) => {
        const active = current === t.key;
        const count = t.key === "all" ? counts.total : counts[t.key];
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-2.5 rounded transition-colors",
              active
                ? "bg-secondary text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary",
            )}
          >
            {t.key === "all" ? (
              <Layers className="h-3 w-3" />
            ) : (
              <span
                className={cn(
                  "inline-flex items-center h-4 px-1 rounded text-[10px] font-medium",
                  t.chip!.class,
                )}
              >
                {t.chip!.label}
              </span>
            )}
            <span>{t.label}</span>
            <span className="font-mono tabular-nums text-muted-foreground">{count}</span>
          </button>
        );
      })}
      <span className="ml-auto inline-flex items-center gap-1.5 text-muted-foreground">
        <Info className="h-3 w-3" />
        <span className="text-[10px]">retrieved at brief-time per agent · no global pool view</span>
      </span>
    </div>
  );
}
