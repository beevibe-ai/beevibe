import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { FooterField } from "@/components/detail/footer-field";
import { SessionStatusPill } from "@/components/detail/status-pill";
import { Skeleton } from "@/components/skeleton";
import type { HierarchyLevel, SessionStatus } from "@beevibe/core";

/**
 * The frame shared by the two session detail pages:
 * `/sessions/[sid]` (a chat conversation) and
 * `/tasks/[id]/sessions/[sid]` (one task-spawned session).
 *
 * Both open with the same avatar + title + status header, close with the
 * same four-field metadata footer, and hand `DetailGate` the same loading
 * skeleton. What differs is the title, the one-line metadata strip under
 * it, and where the footer's values are read from — a single session row on
 * one page, the conversation's last turn on the other.
 *
 * The body between them is genuinely different (a briefing + transcript
 * versus a list of chat turns) and stays in each page.
 */

/** The three bars `DetailGate` shows while either page loads. */
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
 * Avatar, title, status pill, and the metadata strip.
 *
 * `meta` is appended after the agent label and hierarchy chip, which both
 * pages show identically; past that one page lists a duration and the other
 * a turn count and session type. Each `meta` item supplies its own leading
 * separator so a page can render none at all.
 *
 * The avatar's presence dot keys off `status === "running"`, matching how
 * both pages derived it.
 */
export function SessionDetailHeader({
  agentLabel,
  hierarchy,
  status,
  title,
  meta,
}: {
  agentLabel: string;
  hierarchy: HierarchyLevel;
  status: SessionStatus;
  title: ReactNode;
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
            {/* `truncate` matters only on the task page, whose title is a
                formatted intent that can run long; it is inert on the chat
                page's two-word literal. `tracking-tight` is the house style
                on every other h1 in the app — the task page was the one
                place missing it. */}
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

/** A `·` separator for a {@link SessionDetailHeader} `meta` item. */
export function MetaSeparator() {
  return <span className="text-muted-foreground/50">·</span>;
}

/**
 * The metadata footer. `idLabel` + `id` name the thing being viewed — a
 * session on one page, a conversation on the other — and the CLI session and
 * worktree fields are omitted when absent, which is the common case for a
 * session that never reached a daemon.
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
