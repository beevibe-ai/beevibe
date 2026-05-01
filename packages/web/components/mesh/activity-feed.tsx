"use client";

import { useMemo, useState } from "react";
import { Network } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import type { MeshAsk, MeshAskType } from "@/lib/types/mesh";

type Filter = MeshAskType | "all";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ask", label: "ask" },
  { id: "negotiate", label: "negotiate" },
  { id: "blocker", label: "blocker" },
];

export function MeshActivityFeed({ asks }: { asks?: MeshAsk[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const all = useMemo(() => asks ?? [], [asks]);
  const counts = useMemo(() => countByType(all), [all]);
  const visible = filter === "all" ? all : all.filter((a) => a.type === filter);

  return (
    <section className="col-span-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Recent asks{" "}
          <span className="text-muted-foreground/70 tabular-nums">{visible.length}</span>
        </h2>
        <div className="flex items-center gap-1 text-xs">
          {FILTERS.map((f) => {
            const count = f.id === "all" ? all.length : counts[f.id] ?? 0;
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                disabled={f.id !== "all" && count === 0}
                className={cn(
                  "px-2 py-1 rounded transition-colors cursor-pointer",
                  active
                    ? "bg-secondary text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary",
                  f.id !== "all" && count === 0 && "opacity-40 cursor-not-allowed hover:bg-transparent",
                )}
              >
                {f.label}
                {f.id !== "all" && count > 0 ? (
                  <span className="ml-1 tabular-nums opacity-70">{count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border">
          <EmptyState
            icon={Network}
            title={
              all.length === 0
                ? "No mesh asks yet"
                : `No ${filter === "all" ? "" : filter} asks in this window`
            }
            description={
              all.length === 0
                ? "When agents ask each other for help, those exchanges appear here."
                : undefined
            }
          />
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((ask) => (
            <AskRow key={ask.id} ask={ask} />
          ))}
        </ul>
      )}
    </section>
  );
}

function countByType(asks: MeshAsk[]): Record<MeshAsk["type"], number> {
  const counts: Record<MeshAsk["type"], number> = { ask: 0, negotiate: 0, blocker: 0 };
  for (const a of asks) counts[a.type] += 1;
  return counts;
}

function AskRow({ ask }: { ask: MeshAsk }) {
  return (
    <li className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <span className="text-foreground/85">{ask.caller}</span>
        <span>→</span>
        <span className="text-foreground/85">{ask.target}</span>
        {ask.type !== "negotiate" ? (
          <span className="px-1.5 py-0.5 rounded bg-secondary/60 text-foreground/70 text-[10px] uppercase tracking-wider">
            {ask.type}
          </span>
        ) : null}
        <span className="ml-auto tabular-nums">{ask.duration_label}</span>
      </div>
    </li>
  );
}
