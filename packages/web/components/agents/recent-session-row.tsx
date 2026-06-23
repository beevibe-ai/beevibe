"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { RecentSession } from "@/lib/types/agents";
import {
  RECENT_ROW_DOT,
  RECENT_ROW_LINKED_HOVER,
  RECENT_ROW_VARIANT_STYLES,
  type RecentRowVariant,
} from "@/components/agents/recent-row-styles";

/**
 * One recent non-chat session (task / mesh / blocker / run_repo) on the
 * agent detail page. Chat conversations are surfaced separately as
 * collapsed thread cards via `RecentChatThreadRow`.
 *
 * Both wrap the row in a Link when `short_id` is present (always in
 * practice; the unlinked branch is defense against future shapes).
 */
export function RecentSessionRow({
  session,
  variant,
}: {
  session: RecentSession;
  variant: RecentRowVariant;
}) {
  const styles = RECENT_ROW_VARIANT_STYLES[variant];
  const inner = (
    <>
      <span
        className={cn("h-1.5 w-1.5 rounded-full shrink-0", RECENT_ROW_DOT[session.status])}
        aria-hidden
      />
      <span className="flex-1 min-w-0 truncate">{session.title}</span>
      {session.short_id ? (
        <span className={cn("font-mono text-muted-foreground shrink-0", styles.meta)}>
          {session.short_id}
        </span>
      ) : null}
      <span className={cn("text-muted-foreground tabular-nums shrink-0", styles.meta)}>
        {session.age}
      </span>
    </>
  );

  if (!session.short_id) {
    return <li className={styles.row}>{inner}</li>;
  }

  return (
    <li>
      <Link href={`/sessions/${session.short_id}`} className={cn(styles.row, RECENT_ROW_LINKED_HOVER)}>
        {inner}
      </Link>
    </li>
  );
}
