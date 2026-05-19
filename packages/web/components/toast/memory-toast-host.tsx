"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSseEvents, type BvEvent } from "@/lib/sse";
import { api } from "@/lib/api/client";
import { queryKeys } from "@/lib/hooks/keys";
import { cn } from "@/lib/utils";
import type { MemoryFactDisplay } from "@/lib/types/memory-facts";
import type { RichText } from "@/components/rich-text";

/**
 * Bottom-right notification host for memory facts learned by agents.
 *
 * Before: memory facts landed silently via SSE → React Query cache
 * invalidation. User had to be on /memory to know anything happened.
 * Now: a glass-surface toast slides in from the bottom-right when the
 * stream fires `memory.fact.created`, showing the fact's type, scope,
 * agent, and a truncated content preview.
 *
 * Multiple facts arriving close together aggregate into a single toast
 * — the top fact's content stays visible with a "+N more" tail so the
 * notification corner doesn't get spammed during long agent runs.
 */
interface FactMeta {
  factId: string;
  factType: string;
  scope: string;
  agentLabel: string;
  /** Plain-text rendering of the fact content (RichText flattened). */
  content: string;
}

interface ToastEntry {
  id: string;
  /** Newest first; entry[0] is what we render in the toast body. */
  facts: FactMeta[];
  createdAt: number;
}

const AGGREGATE_WINDOW_MS = 3000;
const AUTO_DISMISS_MS = 5500;
const MAX_VISIBLE = 4;
const CONTENT_PREVIEW_CHARS = 90;

function flattenRichText(rt: RichText): string {
  if (typeof rt === "string") return rt;
  // RichSegment = string | { mono: string } — flatten to plain text for
  // the toast. Mono styling is dropped; the content preview is plain.
  return rt.map((s) => (typeof s === "string" ? s : s.mono)).join("");
}

function truncate(s: string, n: number): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length <= n ? trimmed : trimmed.slice(0, n - 1).trimEnd() + "…";
}

/** Map fact_type → a one-word label that fits the metadata strip. */
const FACT_TYPE_LABEL: Record<string, string> = {
  belief: "Belief",
  pattern: "Pattern",
  gotcha: "Gotcha",
  preference: "Preference",
  decision: "Decision",
};

/** Pick a CSS color hint per fact_type using the existing --type-* vars
 *  defined in globals.css. Falls back to muted if the type is unknown. */
function typeAccentClass(factType: string): string {
  switch (factType) {
    case "belief": return "bg-type-belief-bg text-type-belief-fg";
    case "pattern": return "bg-type-pattern-bg text-type-pattern-fg";
    case "gotcha": return "bg-type-gotcha-bg text-type-gotcha-fg";
    case "preference": return "bg-type-preference-bg text-type-preference-fg";
    case "decision": return "bg-type-decision-bg text-type-decision-fg";
    default: return "bg-secondary text-muted-foreground";
  }
}

export function MemoryToastHost() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const queryClient = useQueryClient();

  const handleEvent = useCallback(
    (ev: BvEvent) => {
      if (ev.event !== "memory.fact.created") return;
      // Look up the fact's metadata. The /memory list query may already
      // be cached from a recent visit; fetchQuery uses it if fresh, hits
      // the API otherwise. staleTime: 0 because a fresh fact event
      // implies the cached list is now out of date.
      void queryClient
        .fetchQuery<MemoryFactDisplay[]>({
          queryKey: queryKeys.memory.facts({}),
          queryFn: ({ signal }) => api.memory.listFacts({}, { signal }),
          staleTime: 0,
        })
        .then((facts) => {
          const fact = facts.find((f) => f.id === ev.id);
          if (!fact) return; // fact not visible to this user — skip
          const meta: FactMeta = {
            factId: fact.id,
            factType: fact.fact_type,
            scope: fact.scope,
            agentLabel: fact.agent_label,
            content: truncate(flattenRichText(fact.content), CONTENT_PREVIEW_CHARS),
          };
          setToasts((prev) => {
            const latest = prev[0];
            const now = Date.now();
            if (latest && now - latest.createdAt < AGGREGATE_WINDOW_MS) {
              // Aggregate: prepend the new fact, refresh createdAt so
              // <MemoryToast>'s auto-dismiss timer restarts.
              return [
                {
                  ...latest,
                  facts: [meta, ...latest.facts],
                  createdAt: now,
                },
                ...prev.slice(1),
              ];
            }
            return [
              {
                id: `mem_${now}_${Math.random().toString(36).slice(2, 6)}`,
                facts: [meta],
                createdAt: now,
              },
              ...prev.slice(0, MAX_VISIBLE - 1),
            ];
          });
        })
        .catch(() => {
          // Network failure or signal abort: skip the toast rather than
          // showing a generic "new memory" since metadata is the whole
          // point of this notification.
        });
    },
    [queryClient],
  );

  useSseEvents(handleEvent);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      role="status"
      className="fixed bottom-6 right-6 z-[60] flex flex-col-reverse gap-2 pointer-events-none"
    >
      {toasts.map((t) => (
        <MemoryToast key={t.id} entry={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function MemoryToast({
  entry,
  onDismiss,
}: {
  entry: ToastEntry;
  onDismiss: () => void;
}) {
  // Reset auto-dismiss whenever a new fact aggregates in (deps include
  // facts.length, so the timer restarts on each update).
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [entry.facts.length, onDismiss]);

  const top = entry.facts[0]!;
  const extra = entry.facts.length - 1;
  const typeLabel = FACT_TYPE_LABEL[top.factType] ?? top.factType;

  return (
    <Link
      href="/memory"
      onClick={onDismiss}
      className={cn(
        "pointer-events-auto glass-surface rounded-lg pl-3 pr-2 py-2.5",
        "flex items-start gap-2.5 text-sm shadow-lg cursor-pointer",
        "hover:brightness-110 transition-[filter] animate-toast-in",
        "min-w-[280px] max-w-[360px]",
      )}
    >
      <span className="shrink-0 mt-0.5 h-7 w-7 grid place-items-center rounded-md bg-primary/15 border border-primary/30">
        <Sparkles className="h-3.5 w-3.5 text-amber-400" />
      </span>
      <div className="flex flex-col min-w-0 flex-1 gap-1">
        {/* Metadata strip: type chip · scope · agent. Type chip uses
            the existing per-type color vars defined in globals.css. */}
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider leading-none">
          <span
            className={cn(
              "px-1.5 py-0.5 rounded font-semibold",
              typeAccentClass(top.factType),
            )}
          >
            {typeLabel}
          </span>
          <span className="text-muted-foreground/70">·</span>
          <span className="text-muted-foreground/80">{top.scope}</span>
          <span className="text-muted-foreground/70">·</span>
          <span className="text-muted-foreground/80 truncate">{top.agentLabel}</span>
        </div>
        {/* Content preview + optional aggregation tail. line-clamp keeps
            the toast height bounded when a fact spills over the cap. */}
        <p className="text-[13px] text-foreground leading-snug line-clamp-2">
          {top.content}
          {extra > 0 ? (
            <span className="ml-1 text-muted-foreground/85">
              (+{extra} more)
            </span>
          ) : null}
        </p>
      </div>
      <button
        type="button"
        onClick={(e) => {
          // Stop the link navigation so X dismisses without landing on /memory.
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
        }}
        aria-label="Dismiss"
        className="shrink-0 h-6 w-6 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary/40 cursor-pointer"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </Link>
  );
}
