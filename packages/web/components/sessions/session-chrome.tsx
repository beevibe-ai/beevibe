import type { ReactNode } from "react";
import type { SessionDisplay } from "@/lib/types/sessions";

/**
 * Derived from `SessionDisplay` rather than imported: the api's views/types
 * barrel declares `HierarchyLevel` / `SessionStatus` but doesn't export them,
 * and widening that public surface for two prop types isn't worth it.
 */
type AgentHierarchy = SessionDisplay["agent_hierarchy"];
type Status = SessionDisplay["status"];
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { SessionStatusPill } from "@/components/detail/status-pill";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { FooterField } from "@/components/detail/footer-field";
import { Skeleton } from "@/components/skeleton";
import { cn } from "@/lib/utils";

/**
 * The chrome both session detail pages wrap their body in.
 *
 * `/sessions/[sid]` (a chat conversation) and `/tasks/[id]/sessions/[sid]` (a
 * task-spawned session) render different middles — a turn list vs a briefing
 * plus transcript — but identical top and bottom: the same avatar/title/status
 * header block and the same four-field footer grid. Both were written out
 * twice, so a change to either (the presence dot rule, a footer field, the
 * grid's responsive columns) had to be made in two files that look similar
 * enough to assume you'd already done it.
 *
 * Only what actually differs is a prop: the heading text, the meta items
 * trailing the hierarchy chip, and the first footer field's label.
 */

export function SessionIdentityHeader({
  agentLabel,
  agentHierarchy,
  status,
  title,
  titleClassName,
  meta,
}: {
  agentLabel: string;
  agentHierarchy: AgentHierarchy;
  status: Status;
  title: ReactNode;
  /** Extra classes on the `<h1>`, e.g. `truncate` for a long intent. */
  titleClassName?: string;
  /**
   * Meta items rendered after the hierarchy chip, each expected to supply its
   * own `·` separator — the conversation page shows a turn count and the
   * session type, the task page a duration.
   */
  meta?: ReactNode;
}) {
  return (
    <header className="mb-6">
      <div className="flex items-start gap-3">
        <Avatar
          initial={agentLabel.charAt(0).toUpperCase()}
          kind={agentHierarchy}
          label={agentLabel}
          size={40}
          presence={status === "running" ? "running" : "idle"}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h1 className={cn("text-base font-semibold leading-tight", titleClassName)}>
              {title}
            </h1>
            <SessionStatusPill status={status} />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="text-foreground/85">{agentLabel}</span>
            <HierChip hier={agentHierarchy} />
            {meta}
          </div>
        </div>
      </div>
    </header>
  );
}

/** A `·` separator plus its value, the shape both pages' meta items take. */
export function SessionMetaItem({
  children,
  tabularNums,
}: {
  children: ReactNode;
  /** Set for counts and durations so digits don't jitter as they update. */
  tabularNums?: boolean;
}) {
  return (
    <>
      <span className="text-muted-foreground/50">·</span>
      <span className={tabularNums ? "tabular-nums" : "text-foreground/70"}>{children}</span>
    </>
  );
}

export function SessionFooterFields({
  idLabel,
  id,
  cliSession,
  worktree,
  type,
}: {
  /** "Session ID" on a single session, "Conversation ID" on a chat thread. */
  idLabel: string;
  id: string;
  cliSession?: string;
  worktree?: string;
  type: string;
}) {
  return (
    <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
      <FooterField label={idLabel}>
        <ClickToCopyId id={id} />
      </FooterField>
      {cliSession ? (
        <FooterField label="CLI session" truncate>
          <span className="font-mono">{cliSession}</span>
        </FooterField>
      ) : null}
      {worktree ? (
        <FooterField label="Worktree" truncate>
          <span className="font-mono">{worktree}</span>
        </FooterField>
      ) : null}
      <FooterField label="Type">{type}</FooterField>
    </footer>
  );
}

/**
 * `DetailGate` skeleton for a session page: header bar, then the two stacked
 * cards both pages load into. Byte-identical in both before this.
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
