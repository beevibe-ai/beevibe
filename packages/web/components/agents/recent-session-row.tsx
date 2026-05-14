"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { RecentSession } from "@/lib/types/agents";

/**
 * Status → dot color/animation map. `running` gets the breathing pulse
 * to read as live; `review` uses the review accent; everything else
 * (`succeeded`) lands on the muted "done" green.
 */
const RECENT_SESSION_DOT: Record<RecentSession["status"], string> = {
  running: "bg-status-running animate-pulse-breathe",
  review: "bg-status-review",
  succeeded: "bg-status-done",
};

/**
 * `compact` — peek panel (520px right rail): tighter padding, smaller
 *   text + meta, lighter background to fit the panel's nested context.
 * `comfortable` — full agent detail page: roomier padding, base text,
 *   solid card background.
 *
 * Both wrap the row in a Link when `short_id` is present (always in
 * practice; the unlinked branch is defense against future shapes).
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

export function RecentSessionRow({
  session,
  variant,
}: {
  session: RecentSession;
  variant: Variant;
}) {
  const styles = VARIANT_STYLES[variant];
  const inner = (
    <>
      <span
        className={cn("h-1.5 w-1.5 rounded-full shrink-0", RECENT_SESSION_DOT[session.status])}
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
      <Link href={`/sessions/${session.short_id}`} className={cn(styles.row, LINKED_HOVER)}>
        {inner}
      </Link>
    </li>
  );
}
