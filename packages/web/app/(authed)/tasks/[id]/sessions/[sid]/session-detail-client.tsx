"use client";

import Link from "next/link";
import { AlertTriangle, ChevronRight, Terminal } from "lucide-react";
import { useSession } from "@/lib/hooks/use-sessions";
import { isApiConfigured } from "@/lib/api/config";
import { Avatar } from "@/components/avatar";
import { HierChip } from "@/components/hier-chip";
import { SessionStatusPill } from "@/components/detail/status-pill";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { DetailShell } from "@/components/detail/detail-shell";
import { FooterField } from "@/components/detail/footer-field";
import { BriefingComposer } from "@/components/sessions/briefing-composer";
import { Transcript } from "@/components/sessions/transcript";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { formatIntent, shortId } from "@/lib/format";
import type { SessionDisplay } from "@/lib/types/sessions";

interface Props {
  taskId: string;
  sessionShortId: string;
}

export function SessionDetailClient({ taskId, sessionShortId }: Props) {
  const { data, isLoading, isError } = useSession(sessionShortId);

  const nav = (
    <Breadcrumbs taskId={taskId} taskTitle={data?.task_title ?? null} sessionShortId={sessionShortId} />
  );

  if (!isApiConfigured) {
    return (
      <DetailShell nav={nav}>
        <EmptyState
          icon={Terminal}
          title="API not configured"
          description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load this session."
        />
      </DetailShell>
    );
  }

  if (isLoading) {
    return (
      <DetailShell nav={nav}>
        <Skeleton className="h-14 w-full mb-6" />
        <Skeleton className="h-32 w-full mb-5 rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </DetailShell>
    );
  }

  if (isError || !data) {
    return (
      <DetailShell nav={nav}>
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load session"
          description={`Session ${sessionShortId} could not be fetched.`}
        />
      </DetailShell>
    );
  }

  return (
    <DetailShell nav={nav}>
      <SessionDetailBody session={data} taskId={taskId} />
    </DetailShell>
  );
}

function Breadcrumbs({
  taskId,
  taskTitle,
  sessionShortId,
}: {
  taskId: string;
  taskTitle: string | null;
  sessionShortId: string;
}) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4"
    >
      <Link href="/tasks" className="hover:text-foreground transition-colors">
        Tasks
      </Link>
      <ChevronRight className="h-3 w-3" />
      <Link
        href={`/tasks/${taskId}`}
        className="hover:text-foreground transition-colors max-w-[18rem] truncate"
      >
        {taskTitle ?? shortId(taskId)}
      </Link>
      <ChevronRight className="h-3 w-3" />
      <span className="font-mono text-foreground/80">{sessionShortId}</span>
    </nav>
  );
}

function SessionDetailBody({ session, taskId: _taskId }: { session: SessionDisplay; taskId: string }) {
  // Cancel is a task-level action, not a session-level one — moved to
  // the task detail page. The button used to live here but it called
  // `api.tasks.cancel(taskId)` under the hood, which confused users
  // ("I cancelled the session, why is it still running?") and left the
  // running session orphaned in the daemon-spawn path.
  return (
    <>
      <header className="mb-6">
        <div className="flex items-start gap-3">
          <Avatar
            initial={session.agent_label.charAt(0).toUpperCase()}
            kind={session.agent_hierarchy}
            label={session.agent_label}
            size={40}
            presence={session.status === "running" ? "running" : "idle"}
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h1 className="text-base font-semibold leading-tight truncate">{formatIntent(session.intent)}</h1>
              <SessionStatusPill status={session.status} />
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="text-foreground/85">{session.agent_label}</span>
              <HierChip hier={session.agent_hierarchy} />
              <span className="text-muted-foreground/50">·</span>
              <span className="tabular-nums">{session.duration_label}</span>
            </div>
          </div>
        </div>
      </header>

      <BriefingComposer briefing={session.briefing} />

      <Transcript entries={session.transcript} ask_threads={session.ask_threads} />

      <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
        <FooterField label="Session ID">
          <ClickToCopyId id={session.id} />
        </FooterField>
        {session.cli_session ? (
          <FooterField label="CLI session" truncate>
            <span className="font-mono">{session.cli_session}</span>
          </FooterField>
        ) : null}
        {session.worktree ? (
          <FooterField label="Worktree" truncate>
            <span className="font-mono">{session.worktree}</span>
          </FooterField>
        ) : null}
        <FooterField label="Type">{session.type}</FooterField>
      </footer>
    </>
  );
}
