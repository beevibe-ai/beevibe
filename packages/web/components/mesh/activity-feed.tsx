"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Network, X } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { cn } from "@/lib/utils";
import type { MeshAsk, MeshAskType, MeshHover } from "@/lib/types/mesh";

type Filter = MeshAskType | "all";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ask", label: "ask" },
  { id: "negotiate", label: "negotiate" },
  { id: "blocker", label: "blocker" },
];

const TYPE_BADGE: Record<MeshAskType, string> = {
  ask: "bg-status-running/15 text-status-running",
  negotiate: "bg-status-review/15 text-status-review",
  blocker: "bg-status-blocked/15 text-status-blocked",
};

interface Props {
  asks?: readonly MeshAsk[];
  hover?: MeshHover;
  selectedAgent?: string | null;
  onHoverRow?: (row: { askId: string; caller: string; target: string } | null) => void;
  onClearSelection?: () => void;
}

export function MeshActivityFeed({
  asks,
  hover = null,
  selectedAgent = null,
  onHoverRow,
  onClearSelection,
}: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const all = useMemo(() => asks ?? [], [asks]);
  const counts = useMemo(() => countByType(all), [all]);

  const visible = useMemo(() => {
    let next: readonly MeshAsk[] = filter === "all" ? all : all.filter((a) => a.type === filter);
    if (selectedAgent) {
      next = next.filter((a) => a.caller === selectedAgent || a.target === selectedAgent);
    }
    return next;
  }, [all, filter, selectedAgent]);

  const hoveredNodeLabel = hover?.kind === "node" ? hover.label : null;
  const hoveredRowId = hover?.kind === "row" ? hover.askId : null;

  return (
    <section className="col-span-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground">
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

      {selectedAgent ? (
        <div className="mb-3 inline-flex items-center gap-2 text-xs bg-secondary/70 border border-border pl-2.5 pr-1.5 py-1 rounded-md">
          <span className="text-muted-foreground">Filtered to</span>
          <span className="text-foreground font-medium">{selectedAgent}</span>
          <button
            type="button"
            onClick={onClearSelection}
            className="p-0.5 rounded hover:bg-secondary cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Clear filter"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border">
          <EmptyState
            icon={Network}
            title={
              all.length === 0
                ? "No mesh asks yet"
                : selectedAgent
                  ? `No asks for ${selectedAgent}`
                  : `No ${filter === "all" ? "" : filter} asks in this window`
            }
            description={
              all.length === 0
                ? "When agents ask each other for help, exchanges appear here. Ask your team agent to spawn a few subordinates and assign them work."
                : undefined
            }
            cta={all.length === 0 ? { href: "/", label: "Open chat" } : undefined}
          />
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((ask) => {
            const dim = hoveredNodeLabel
              ? ask.caller !== hoveredNodeLabel && ask.target !== hoveredNodeLabel
              : false;
            const highlighted = hoveredRowId === ask.id;
            return (
              <AskRow
                key={ask.id}
                ask={ask}
                dim={dim}
                highlighted={highlighted}
                selectedAgent={selectedAgent}
                onEnter={() =>
                  onHoverRow?.({ askId: ask.id, caller: ask.caller, target: ask.target })
                }
                onLeave={() => onHoverRow?.(null)}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}

function countByType(asks: readonly MeshAsk[]): Record<MeshAsk["type"], number> {
  const counts: Record<MeshAsk["type"], number> = { ask: 0, negotiate: 0, blocker: 0 };
  for (const a of asks) counts[a.type] += 1;
  return counts;
}

interface RowProps {
  ask: MeshAsk;
  dim: boolean;
  highlighted: boolean;
  selectedAgent: string | null;
  onEnter: () => void;
  onLeave: () => void;
}

function AskRow({ ask, dim, highlighted, selectedAgent, onEnter, onLeave }: RowProps) {
  const inner = (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <AgentName name={ask.caller} highlight={selectedAgent === ask.caller} />
      <span className="text-muted-foreground/60 shrink-0">→</span>
      <AgentName name={ask.target} highlight={selectedAgent === ask.target} />
      <span
        className={cn(
          "px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider font-medium",
          TYPE_BADGE[ask.type],
        )}
      >
        {ask.type}
      </span>
      <span className="ml-auto tabular-nums shrink-0">{ask.duration_label}</span>
    </div>
  );

  const className = cn(
    "block rounded-lg border p-3 text-sm transition-all duration-150",
    highlighted
      ? "border-foreground/30 bg-secondary/40 shadow-sm"
      : "border-border bg-card hover:bg-secondary/50 hover:border-border/80",
    dim && "opacity-40",
  );

  // Each mesh ask is anchored to the source task that initiated it; the task
  // detail page is the canonical surface for the full conversation. Defensive
  // fallback to unlinked when source_task_short_id is missing.
  if (!ask.source_task_short_id) {
    return (
      <li>
        <div className={className} onMouseEnter={onEnter} onMouseLeave={onLeave}>
          {inner}
        </div>
      </li>
    );
  }

  return (
    <li>
      <Link
        href={`/tasks/${ask.source_task_short_id}`}
        className={cn(className, "cursor-pointer")}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        {inner}
      </Link>
    </li>
  );
}

function AgentName({ name, highlight }: { name: string; highlight: boolean }) {
  return (
    <span
      className={cn(
        "truncate max-w-[180px]",
        highlight ? "text-foreground font-medium" : "text-foreground/85",
      )}
    >
      {name}
    </span>
  );
}
