import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { SessionStatusPill } from "@/components/detail/status-pill";
import { Skeleton } from "@/components/skeleton";
import type { SessionDisplay } from "@/lib/types/sessions";

/**
 * Header for the two session detail pages — the task-scoped one at
 * `/tasks/[id]/sessions/[sid]` and the chat/conversation one at
 * `/sessions/[sid]`.
 *
 * Both rendered the same four nested divs: the running-aware avatar, the
 * title line with its status pill, and the meta row opening with the agent
 * label and its hierarchy chip. Only the title text and the tail of the meta
 * row ever differed, so those are the two props; everything else is fixed
 * here.
 *
 * One drift settled in the move: the task-scoped page's `<h1>` had `truncate`
 * (its title is the session intent, which can run long) and the chat page's
 * had `tracking-tight` (its title is the word "Conversation"). The shared h1
 * carries both — the only visible change, and both pages look right under it.
 */
export function SessionDetailHeader({
  agentLabel,
  hierarchy,
  status,
  title,
  meta,
}: {
  agentLabel: string;
  hierarchy: SessionDisplay["agent_hierarchy"];
  status: SessionDisplay["status"];
  /** Rendered as the `<h1>`, left of the status pill. */
  title: string;
  /** Meta-row items after the hierarchy chip — duration, turn count, type. */
  meta?: ReactNode;
}) {
  return (
    <header className="mb-6">
      <div className="flex items-start gap-3">
        <Avatar
          initial={agentLabel.charAt(0).toUpperCase()}
          kind={hierarchy}
          label={agentLabel}
          size={40}
          presence={status === "running" ? "running" : "idle"}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-base font-semibold tracking-tight leading-tight truncate">
              {title}
            </h1>
            <SessionStatusPill status={status} />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="text-foreground/85">{agentLabel}</span>
            <HierChip hier={hierarchy} />
            {meta}
          </div>
        </div>
      </div>
    </header>
  );
}

/** The `·` between meta-row items. Four hand-written copies across the two pages. */
export function MetaDot() {
  return <span className="text-muted-foreground/50">·</span>;
}

/**
 * Loading placeholder for both session detail pages — header band, briefing
 * or first-turn card, transcript. The two pages passed byte-identical
 * `skeleton` props to `DetailGate`.
 */
export function SessionDetailSkeleton() {
  return (
    <>
      <Skeleton className="h-14 w-full mb-6" />
      <Skeleton className="h-32 w-full mb-5 rounded-lg" />
      <Skeleton className="h-64 w-full rounded-lg" />
    </>
  );
}
