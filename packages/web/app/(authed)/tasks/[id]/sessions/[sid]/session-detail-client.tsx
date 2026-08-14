"use client";

import Link from "next/link";
import { ChevronRight, Terminal } from "lucide-react";
import { useSession } from "@/lib/hooks/use-sessions";
import { DetailGate } from "@/components/detail/detail-gate";
import { BriefingComposer } from "@/components/sessions/briefing-composer";
import {
  SessionDetailSkeleton,
  SessionIdentityHeader,
  SessionMetaFooter,
} from "@/components/sessions/session-detail-chrome";
import { Transcript } from "@/components/sessions/transcript";
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
      skeleton={<SessionDetailSkeleton />}
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
      <SessionIdentityHeader
        agentLabel={session.agent_label}
        agentHierarchy={session.agent_hierarchy}
        status={session.status}
        title={formatIntent(session.intent)}
        meta={[
          <span key="duration" className="tabular-nums">
            {session.duration_label}
          </span>,
        ]}
      />

      <BriefingComposer briefing={session.briefing} />

      <Transcript entries={session.transcript} ask_threads={session.ask_threads} />

      <SessionMetaFooter
        idLabel="Session ID"
        id={session.id}
        cliSession={session.cli_session}
        worktree={session.worktree}
        type={session.type}
      />
    </>
  );
}
