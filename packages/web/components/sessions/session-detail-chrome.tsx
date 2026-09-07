import { Fragment, type ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { FooterField } from "@/components/detail/footer-field";
import { SessionStatusPill } from "@/components/detail/status-pill";
import { HierChip } from "@/components/hier-chip";
import { Skeleton } from "@/components/skeleton";
import type { SessionDisplay } from "@/lib/types/sessions";
import { cn } from "@/lib/utils";

/**
 * The frame the two session detail pages share.
 *
 * `/sessions/[sid]` (a chat conversation, collapsed from its per-turn
 * sessions) and `/tasks/[id]/sessions/[sid]` (one task-spawned session)
 * show different bodies but the identical chrome around it: the same
 * three-bar loading skeleton, the same avatar-and-status header, and
 * the same four-column id/CLI-session/worktree/type footer. All three
 * were written out twice, so a change to the header layout — or, worse,
 * to the conditionals that hide an absent worktree — had to be made in
 * both files to stick.
 *
 * The bodies stay where they are. Only the frame lives here.
 */

/** Header bar, footer row, then the body area. */
export function SessionDetailSkeleton() {
  return (
    <>
      <Skeleton className="h-14 w-full mb-6" />
      <Skeleton className="h-32 w-full mb-5 rounded-lg" />
      <Skeleton className="h-64 w-full rounded-lg" />
    </>
  );
}

/**
 * Avatar, title, status pill, and a metadata line.
 *
 * `titleClassName` exists because the two pages want different overflow
 * behavior from the same slot: the chat page's title is one of two fixed
 * words so it takes `tracking-tight`, while the task page renders the
 * session's intent and needs `truncate`.
 *
 * `meta` is a list rather than a single node so this component owns the
 * `·` separators between the entries — that is the part the two copies
 * were most likely to get out of step, since how many entries there are
 * is itself conditional (the chat page hides its turn count on a
 * single-turn conversation). Nullish entries are dropped, separator and
 * all.
 */
export function SessionDetailHeader({
  agentLabel,
  agentHierarchy,
  status,
  title,
  titleClassName,
  meta = [],
}: {
  agentLabel: string;
  agentHierarchy: SessionDisplay["agent_hierarchy"];
  status: SessionDisplay["status"];
  title: string;
  titleClassName?: string;
  meta?: ReactNode[];
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
            {meta.map((entry, i) =>
              entry == null ? null : (
                <Fragment key={i}>
                  <span className="text-muted-foreground/50">·</span>
                  {entry}
                </Fragment>
              ),
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

/**
 * The identifiers strip at the bottom of the page.
 *
 * `idLabel` is a parameter because the two pages copy different ids: the
 * chat page the conversation's, the task page the session's. CLI session
 * and worktree drop out entirely when the runtime didn't report them,
 * which is the common case for a chat turn.
 */
export function SessionDetailFooter({
  idLabel,
  id,
  cliSession,
  worktree,
  type,
}: {
  idLabel: string;
  id: string;
  cliSession?: string | null;
  worktree?: string | null;
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
