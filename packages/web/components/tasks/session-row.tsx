"use client";

import Link from "next/link";
import { Terminal } from "lucide-react";
import { SessionStatusPill } from "@/components/detail/status-pill";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TaskDetailSessionRow } from "@/lib/api/types";

/**
 * `compact` — task peek panel (right rail): tighter padding and smaller
 *   meta text, and the agent label truncates because the rail is narrow.
 * `comfortable` — full task detail page: roomier padding, base text, solid
 *   card background, label free to wrap.
 *
 * Same variant axis as `RECENT_ROW_VARIANT_STYLES` on the agent side, and
 * the class strings are carried over verbatim from the two copies this
 * replaced — so neither surface changes how it renders.
 */
type SessionRowVariant = "compact" | "comfortable";

const VARIANT: Record<
  SessionRowVariant,
  {
    link: string;
    header: string;
    icon: string;
    id: string;
    label: string;
    summary: string;
    meta: string;
  }
> = {
  compact: {
    link: "rounded-md border border-border/70 bg-background/40 px-2.5 py-1.5",
    header: "gap-1.5 mb-0.5",
    icon: "h-3 w-3",
    id: "text-[11px]",
    label: "text-[11px] truncate",
    summary: "text-[11px]",
    meta: "mt-1 text-[10px]",
  },
  comfortable: {
    link: "rounded-lg border border-border bg-card p-3",
    header: "gap-2 mb-1",
    icon: "h-3.5 w-3.5",
    id: "text-xs",
    label: "text-xs",
    summary: "text-xs",
    meta: "mt-1.5 text-[11px]",
  },
};

/**
 * One session beneath a task — short id, agent, status, result summary and
 * timing, linking to the session detail page.
 *
 * The panel and the full page had grown their own `SessionRow`, identical
 * in structure and data and differing only in sizing. That meant adding a
 * field (or fixing the link) had to be remembered twice.
 */
export function SessionRow({
  session,
  taskId,
  variant,
}: {
  session: TaskDetailSessionRow;
  taskId: string;
  variant: SessionRowVariant;
}) {
  const styles = VARIANT[variant];

  return (
    <li>
      <Link
        href={`/tasks/${taskId}/sessions/${session.short_id}`}
        className={cn("block hover:bg-secondary/30 transition-colors", styles.link)}
      >
        <div className={cn("flex items-center", styles.header)}>
          <Terminal className={cn("text-muted-foreground", styles.icon)} />
          <span className={cn("font-mono", styles.id)}>{session.short_id}</span>
          <span className={cn("text-muted-foreground", styles.label)}>{session.agent_label}</span>
          <SessionStatusPill status={session.status} className="ml-auto" />
        </div>
        {session.result_summary ? (
          <p className={cn("text-muted-foreground line-clamp-2 mt-1", styles.summary)}>
            {session.result_summary}
          </p>
        ) : null}
        <div className={cn("text-muted-foreground/70 tabular-nums", styles.meta)}>
          {session.duration_label} · {formatRelativeTime(session.started_at)}
        </div>
      </Link>
    </li>
  );
}
