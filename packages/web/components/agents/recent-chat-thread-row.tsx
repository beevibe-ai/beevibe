"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { RecentChatThread } from "@beevibe/api/views/types";
import {
  RECENT_ROW_DOT,
  RECENT_ROW_LINKED_HOVER,
  RECENT_ROW_VARIANT_STYLES,
  type RecentRowVariant,
} from "@/components/agents/recent-row-styles";

/**
 * One collapsed chat-conversation card on the agent detail page. Groups N
 * chat-turn sessions sharing a `conversation_id` into a single row — the
 * head turn's first message as the title, a turn-count chip, and the
 * most-recent-turn age. Links to the read-only conversation detail page,
 * which expands the whole thread. Sibling of `RecentSessionRow` (shared
 * dot/variant styling).
 */
export function RecentChatThreadRow({
  thread,
  variant,
}: {
  thread: RecentChatThread;
  variant: RecentRowVariant;
}) {
  const styles = RECENT_ROW_VARIANT_STYLES[variant];
  return (
    <li>
      <Link
        href={`/sessions/${thread.short_id}`}
        className={cn(styles.row, RECENT_ROW_LINKED_HOVER)}
      >
        <span
          className={cn("h-1.5 w-1.5 rounded-full shrink-0", RECENT_ROW_DOT[thread.last_status])}
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
