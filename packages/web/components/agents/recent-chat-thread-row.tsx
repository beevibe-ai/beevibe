"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { RecentChatThread } from "@beevibe/api/views/types";

/**
 * Status → dot color/animation map. Mirrors `recent-session-row.tsx`:
 * `running` (latest turn mid-LLM-call) gets the breathing pulse; the
 * rest land on the muted "done" green. Keyed off `last_status`.
 */
const THREAD_DOT: Record<RecentChatThread["last_status"], string> = {
  running: "bg-status-running animate-pulse-breathe",
  review: "bg-status-review",
  succeeded: "bg-status-done",
};

/**
 * One collapsed chat-conversation card on the agent detail page. Groups N
 * chat-turn sessions sharing a `conversation_id` into a single row — the
 * head turn's first message as the title, a turn-count chip, and the
 * most-recent-turn age. Links to the read-only conversation detail page,
 * which expands the whole thread.
 *
 * `compact` — peek panel (right rail). `comfortable` — full detail page.
 * Mirrors `RecentSessionRow`'s variants so the two lists read as siblings.
 */
type Variant = "compact" | "comfortable";

const VARIANT_STYLES: Record<Variant, { row: string; meta: string }> = {
  compact: {
    row: "flex items-center gap-2 rounded-md border border-border/70 bg-background/40 px-2.5 py-1.5 text-xs",
    meta: "text-[10px]",
  },
  comfortable: {
    row: "flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm",
    meta: "text-xs",
  },
};

const LINKED_HOVER =
  "hover:bg-secondary/50 hover:border-border/80 transition-colors cursor-pointer";

export function RecentChatThreadRow({
  thread,
  variant,
}: {
  thread: RecentChatThread;
  variant: Variant;
}) {
  const styles = VARIANT_STYLES[variant];
  return (
    <li>
      <Link
        href={`/sessions/${thread.short_id}`}
        className={cn(styles.row, LINKED_HOVER)}
      >
        <span
          className={cn("h-1.5 w-1.5 rounded-full shrink-0", THREAD_DOT[thread.last_status])}
          aria-hidden
        />
        <span className="flex-1 min-w-0 truncate">{thread.title}</span>
        <span className={cn("text-muted-foreground tabular-nums shrink-0", styles.meta)}>
          {thread.turn_count} {thread.turn_count === 1 ? "turn" : "turns"}
        </span>
        <span className={cn("text-muted-foreground tabular-nums shrink-0", styles.meta)}>
          {thread.age}
        </span>
      </Link>
    </li>
  );
}
