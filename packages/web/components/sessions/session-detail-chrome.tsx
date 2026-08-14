import { Fragment, type ReactNode } from "react";
import type { HierarchyLevel, SessionStatus } from "@beevibe/core";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { FooterField } from "@/components/detail/footer-field";
import { SessionStatusPill } from "@/components/detail/status-pill";
import { Skeleton } from "@/components/skeleton";

/**
 * The chrome shared by the two session detail pages —
 * `/sessions/[sid]` (a chat conversation) and
 * `/tasks/[id]/sessions/[sid]` (a task-spawned session).
 *
 * The two pages render genuinely different bodies (a turn-by-turn chat
 * thread vs. a briefing + tool transcript), but they wrap that body in
 * the same identity header, the same metadata footer, and the same
 * loading skeleton — all three were maintained as parallel copies.
 *
 * The footer is the one that matters most: it is the "which process
 * produced this" affordance (CLI session id, worktree path) that
 * operators use to correlate a session with a daemon log, and it must
 * read identically no matter which of the two pages you reached the
 * session from. Two copies meant two chances for those fields to drift
 * apart in wording or ordering.
 */

/**
 * Avatar + title + status pill, over a meta line of
 * `agent name · hierarchy · …`.
 *
 * `meta` holds the page-specific tail of that line — turn count and
 * session type on the chat page, elapsed duration on the task page.
 * Entries are rendered dot-separated, and `null` entries are dropped,
 * so a caller can pass a conditional item inline without also having to
 * manage the separator that precedes it.
 */
export function SessionIdentityHeader({
  agentLabel,
  agentHierarchy,
  status,
  title,
  meta = [],
}: {
  agentLabel: string;
  agentHierarchy: HierarchyLevel;
  status: SessionStatus;
  title: ReactNode;
  meta?: Array<ReactNode | null>;
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
            <h1 className="text-base font-semibold tracking-tight leading-tight truncate">
              {title}
            </h1>
            <SessionStatusPill status={status} />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="text-foreground/85">{agentLabel}</span>
            <HierChip hier={agentHierarchy} />
            {meta.map((item, i) =>
              item == null ? null : (
                // A Fragment, not a wrapper element: the separator and
                // the item must stay direct children of the flex row so
                // they pick up its `gap-2`. Index keys are safe — `meta`
                // is a fixed-shape literal at each call site, never a
                // reordered list.
                <Fragment key={i}>
                  <span className="text-muted-foreground/50">·</span>
                  {item}
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
 * The four-field process-provenance footer. `cliSession` and `worktree`
 * are omitted rather than rendered empty when the session never got as
 * far as spawning a process.
 */
export function SessionMetaFooter({
  idLabel,
  id,
  cliSession,
  worktree,
  type,
}: {
  /** "Session ID" on the task page, "Conversation ID" on the chat page. */
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

/** `DetailGate`'s `skeleton` for both session pages: header, panel, transcript. */
export function SessionDetailSkeleton() {
  return (
    <>
      <Skeleton className="h-14 w-full mb-6" />
      <Skeleton className="h-32 w-full mb-5 rounded-lg" />
      <Skeleton className="h-64 w-full rounded-lg" />
    </>
  );
}
