"use client";

import Link from "next/link";
import { ChevronRight, Terminal } from "lucide-react";
import { useSession } from "@/lib/hooks/use-sessions";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { DetailGate } from "@/components/detail/detail-gate";
import { FooterField } from "@/components/detail/footer-field";
import { DetailFooter } from "@/components/detail/detail-footer";
import { BriefingComposer } from "@/components/sessions/briefing-composer";
import { SessionHeader } from "@/components/sessions/session-header";
import { Transcript } from "@/components/sessions/transcript";
import { Skeleton } from "@/components/skeleton";
import { formatIntent, shortId } from "@/lib/format";
import type { SessionDisplay } from "@/lib/types/sessions";

interface Props {
  taskId: string;
  sessionShortId: string;
}

export function SessionDetailClient({ taskId, sessionShortId }: Props) {
  const query = useSession(sessionShortId);

  return (
    <DetailGate
      nav={
        <Breadcrumbs
          taskId={taskId}
          taskTitle={query.data?.task_title ?? null}
          sessionShortId={sessionShortId}
        />
      }
      icon={Terminal}
      noun="session"
      id={sessionShortId}
      query={query}
      skeleton={
        <>
          <Skeleton className="h-14 w-full mb-6" />
          <Skeleton className="h-32 w-full mb-5 rounded-lg" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </>
      }
    >
      {(session) => <SessionDetailBody session={session} taskId={taskId} />}
    </DetailGate>
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
      <SessionHeader
        agentLabel={session.agent_label}
        agentHierarchy={session.agent_hierarchy}
        status={session.status}
        title={formatIntent(session.intent)}
        meta={
          <>
            <span className="text-muted-foreground/50">·</span>
            <span className="tabular-nums">{session.duration_label}</span>
          </>
        }
      />

      <BriefingComposer briefing={session.briefing} />

      <Transcript entries={session.transcript} ask_threads={session.ask_threads} />

      <DetailFooter>
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
      </DetailFooter>
    </>
  );
}
