"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles, X } from "lucide-react";
import { useSseEvents, type BvEvent } from "@/lib/sse";
import { cn } from "@/lib/utils";

/**
 * Bottom-right notification host for memory facts learned by agents.
 *
 * Before: memory facts landed silently via SSE → React Query cache
 * invalidation. User had to be on /memory to know anything happened.
 * Now: a glass-surface toast slides in from the bottom-right when the
 * stream fires `memory.fact.created`. Clicks navigate to /memory.
 *
 * Multiple facts arriving close together (common during long agent
 * runs) aggregate into a single toast with a count instead of
 * spamming the corner — bumps the `count` and refreshes the
 * auto-dismiss timer on each new event within AGGREGATE_WINDOW_MS.
 */
interface ToastEntry {
  id: string;
  count: number;
  /** Mutable so we can reset on aggregation without spawning new entries. */
  createdAt: number;
}

/** Window during which a new fact event extends the existing toast
 *  instead of stacking a new one. */
const AGGREGATE_WINDOW_MS = 3000;
/** How long each toast stays visible after the last update. */
const AUTO_DISMISS_MS = 4500;
/** Cap so a long burst of unrelated bursts doesn't pile up. */
const MAX_VISIBLE = 4;

export function MemoryToastHost() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const handleEvent = useCallback((ev: BvEvent) => {
    if (ev.event !== "memory.fact.created") return;
    setToasts((prev) => {
      const latest = prev[0];
      const now = Date.now();
      if (latest && now - latest.createdAt < AGGREGATE_WINDOW_MS) {
        // Aggregate: bump count + refresh createdAt so the auto-dismiss
        // timer in <MemoryToast/> restarts (effect deps include count).
        return [
          { ...latest, count: latest.count + 1, createdAt: now },
          ...prev.slice(1),
        ];
      }
      return [
        {
          id: `mem_${now}_${Math.random().toString(36).slice(2, 6)}`,
          count: 1,
          createdAt: now,
        },
        ...prev.slice(0, MAX_VISIBLE - 1),
      ];
    });
  }, []);

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
  // Reset the auto-dismiss timer whenever count bumps — the toast
  // stays visible as long as facts keep landing within the window.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [entry.count, onDismiss]);

  const label =
    entry.count === 1
      ? "New memory learned"
      : `${entry.count} new memories learned`;

  return (
    <Link
      href="/memory"
      onClick={onDismiss}
      className={cn(
        "pointer-events-auto glass-surface rounded-lg pl-3 pr-2 py-2",
        "flex items-center gap-2.5 text-sm shadow-lg cursor-pointer",
        "hover:brightness-110 transition-[filter] animate-toast-in",
        "min-w-[240px] max-w-[320px]",
      )}
    >
      <span className="shrink-0 h-7 w-7 grid place-items-center rounded-md bg-primary/15 border border-primary/30">
        <Sparkles className="h-3.5 w-3.5 text-amber-400" />
      </span>
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-foreground font-medium leading-tight truncate">
          {label}
        </span>
        <span className="text-[11px] text-muted-foreground leading-tight">
          View memory
        </span>
      </div>
      <button
        type="button"
        onClick={(e) => {
          // Stop the link navigation so the user can dismiss without
          // landing on /memory.
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
        }}
        aria-label="Dismiss"
        className="ml-1 shrink-0 h-6 w-6 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary/40 cursor-pointer"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </Link>
  );
}
