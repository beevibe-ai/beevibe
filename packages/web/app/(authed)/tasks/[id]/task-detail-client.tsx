"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowLeft,
  AlertTriangle,
  FileText,
  ListChecks,
  Terminal,
} from "lucide-react";
import { useTask } from "@/lib/hooks/use-tasks";
import {
  useApproveTask,
  useCancelTask,
  useRejectTask,
  useReviseTask,
} from "@/lib/hooks/use-task-mutations";
import { isApiConfigured } from "@/lib/api/config";
import { TaskStatusPill, SessionStatusPill } from "@/components/detail/status-pill";
import { ChatMarkdown } from "@/components/chat/markdown";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { DetailShell } from "@/components/detail/detail-shell";
import { FooterField } from "@/components/detail/footer-field";
import { HierChip } from "@/components/hier-chip";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { richTextToMarkdown } from "@/components/rich-text";
import { formatRelativeTime, shortId } from "@/lib/format";
import type { TaskDetail, TaskDetailSessionRow } from "@/lib/api/types";
import type { WorkProduct } from "@beevibe/core";

const TasksBackLink = () => (
  <Link
    href="/tasks"
    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
  >
    <ArrowLeft className="h-3 w-3" />
    Tasks
  </Link>
);

export function TaskDetailClient({ taskId }: { taskId: string }) {
  const { data, isLoading, isError } = useTask(taskId);

  if (!isApiConfigured) {
    return (
      <DetailShell nav={<TasksBackLink />}>
        <EmptyState
          icon={ListChecks}
          title="API not configured"
          description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load this task."
        />
      </DetailShell>
    );
  }

  if (isLoading) {
    return (
      <DetailShell nav={<TasksBackLink />}>
        <Skeleton className="h-8 w-2/3 mb-2" />
        <Skeleton className="h-4 w-1/3 mb-6" />
        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-4">
            <Skeleton className="h-32 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </DetailShell>
    );
  }

  if (isError || !data) {
    return (
      <DetailShell nav={<TasksBackLink />}>
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load task"
          description={`Task ${taskId} could not be fetched. Check the MCP server logs.`}
        />
      </DetailShell>
    );
  }

  return <TaskDetailLoaded task={data} />;
}

type ReviewMutation = "approve" | "reject" | "revise";

function reviewStatus(
  hooks: Record<ReviewMutation, { isPending: boolean; isError: boolean; error: Error | null }>,
) {
  const actions: ReviewMutation[] = ["approve", "reject", "revise"];
  return {
    anyPending: actions.some((a) => hooks[a].isPending),
    lastError: actions.map((a) => hooks[a].error).find((e) => e) ?? null,
    lastErrorAction: actions.find((a) => hooks[a].isError) ?? null,
  };
}

// Mirrors CANCELLABLE_FROM in packages/api/src/routes/task.ts — the
// statuses where the api will accept a cancel. Terminal statuses
// (done/failed/cancelled) reject with 409, so don't show the button.
const TASK_TERMINAL_STATUSES = ["done", "failed", "cancelled"] as const;

function TaskDetailLoaded({ task }: { task: TaskDetail }) {
  const isInReview = task.status === "review";
  const isTerminal = (TASK_TERMINAL_STATUSES as readonly string[]).includes(task.status);
  const activeSession = task.latest_session?.status === "running" ? task.latest_session : null;
  const approve = useApproveTask(task.id);
  const reject = useRejectTask(task.id);
  const revise = useReviseTask(task.id);
  const cancel = useCancelTask(task.id);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseFeedback, setReviseFeedback] = useState("");

  const { anyPending: reviewPending, lastError, lastErrorAction } = reviewStatus({ approve, reject, revise });
  // Cancel disables the review actions too — if cancel is in flight,
  // the task is about to become terminal and approve/reject/revise
  // would race against it.
  const anyPending = reviewPending || cancel.isPending;

  const submitRevise = () => {
    const feedback = reviseFeedback.trim();
    if (!feedback) return;
    revise.mutate(
      { feedback },
      {
        onSuccess: () => {
          setReviseFeedback("");
          setReviseOpen(false);
        },
      },
    );
  };

  return (
    <DetailShell nav={<TasksBackLink />}>
      <header className="mb-6">
        <div className="flex items-start justify-between gap-6 mb-2">
          <h1 className="text-base font-semibold tracking-tight leading-tight flex-1 min-w-0">{task.title}</h1>
          <div className="flex items-center gap-1.5 mt-1.5 shrink-0">
            <TaskStatusPill status={task.status} />
            {task.assignee_hierarchy ? <HierChip hier={task.assignee_hierarchy} /> : null}
            {!isTerminal ? (
              <button
                type="button"
                disabled={anyPending}
                onClick={() => cancel.mutate({})}
                className="h-7 px-2.5 rounded text-xs font-medium border border-border text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="Cancel this task — stops any running session"
              >
                {cancel.isPending ? "Cancelling…" : "Cancel"}
              </button>
            ) : null}
          </div>
        </div>
        {cancel.isError ? (
          <div className="text-xs text-status-failed text-right mb-2">
            Couldn&apos;t cancel: {cancel.error.message}
          </div>
        ) : null}

        {isInReview ? (
          <>
            <div className="flex justify-end gap-2 mb-2">
              <button
                type="button"
                disabled={anyPending}
                onClick={() => reject.mutate({})}
                className="h-9 px-3 rounded text-sm font-medium border border-border hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {reject.isPending ? "Rejecting…" : "Reject"}
              </button>
              <button
                type="button"
                disabled={anyPending}
                onClick={() => setReviseOpen((v) => !v)}
                className="h-9 px-3 rounded text-sm font-medium border border-border hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Request revision
              </button>
              <button
                type="button"
                disabled={anyPending}
                onClick={() => approve.mutate({})}
                className="h-9 px-3 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {approve.isPending ? "Approving…" : "Approve"}
              </button>
            </div>
            {reviseOpen ? (
              <div className="mb-2 rounded-lg border border-border bg-card p-3 space-y-2">
                <label className="block text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                  Revision feedback
                </label>
                <textarea
                  value={reviseFeedback}
                  onChange={(e) => setReviseFeedback(e.target.value)}
                  placeholder="What needs to change?"
                  rows={3}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setReviseOpen(false);
                      setReviseFeedback("");
                    }}
                    className="h-8 px-3 rounded text-xs font-medium border border-border hover:bg-secondary transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={anyPending || reviseFeedback.trim().length === 0}
                    onClick={submitRevise}
                    className="h-8 px-3 rounded text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {revise.isPending ? "Submitting…" : "Submit revision"}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        {lastError ? (
          <div className="text-xs text-status-failed text-right">
            Couldn&apos;t {lastErrorAction ?? "submit"}: {lastError.message}
          </div>
        ) : null}
      </header>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 space-y-5">
          <section className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
              Description
            </h2>
            {task.description?.length ? (
              <div className="text-foreground/90">
                <ChatMarkdown
                  content={task.description.map(richTextToMarkdown).join("\n\n")}
                />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground italic">No description.</p>
            )}
          </section>

          {task.result_summary ? (
            <section className="rounded-lg border border-border bg-card p-5">
              <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
                Result summary
              </h2>
              <div className="text-foreground/90">
                <ChatMarkdown content={richTextToMarkdown(task.result_summary)} />
              </div>
            </section>
          ) : null}

          <section>
            <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
              Work products{" "}
              <span className="text-muted-foreground/70 tabular-nums">
                {task.work_products.length}
              </span>
            </h2>
            {task.work_products.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No work products yet.</p>
            ) : (
              <ul className="space-y-2">
                {task.work_products.map((wp) => (
                  <WorkProductCard key={wp.id} wp={wp} />
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
              Sessions{" "}
              <span className="text-muted-foreground/70 tabular-nums">{task.sessions.length}</span>
            </h2>
            {task.sessions.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">No sessions yet.</p>
            ) : (
              <ul className="space-y-2">
                {task.sessions.map((s) => (
                  <SessionRow key={s.id} session={s} taskId={task.id} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="col-span-1 space-y-4">
          {task.status === "blocked" && task.blocker_reason ? (
            <section className="rounded-lg border border-status-blocked/40 bg-status-blocked/5 p-4">
              <h3 className="text-[11px] uppercase tracking-wider text-status-blocked mb-2 font-medium">
                Blocked
              </h3>
              <p className="text-sm text-foreground">{task.blocker_reason}</p>
            </section>
          ) : null}

          {activeSession ? (
            <section className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2 font-medium">
                Active session
              </h3>
              <Link
                href={`/tasks/${task.id}/sessions/${activeSession.short_id}`}
                className="block hover:bg-secondary/30 -mx-2 px-2 py-1.5 rounded transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-mono text-xs">{activeSession.short_id}</span>
                  <SessionStatusPill status="running" className="ml-auto" />
                </div>
                <div className="text-xs text-muted-foreground">
                  {activeSession.agent_label} · {activeSession.elapsed}
                </div>
              </Link>
            </section>
          ) : null}
        </aside>
      </div>

      <footer className="mt-10 pt-5 border-t border-border/60 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3 text-xs text-muted-foreground">
        <FooterField label="ID">
          <ClickToCopyId id={task.id} />
        </FooterField>
        <FooterField label="Priority">{task.priority}</FooterField>
        <FooterField label="Created">{formatRelativeTime(task.created_at)}</FooterField>
        <FooterField label="Updated">{formatRelativeTime(task.updated_at)}</FooterField>
        {task.assignee_label ? (
          <FooterField label="Assignee">{task.assignee_label}</FooterField>
        ) : null}
        {task.creator_label ? (
          <FooterField label="Creator">{task.creator_label}</FooterField>
        ) : null}
        {task.parent_task_id ? (
          <FooterField label="Parent">
            <Link
              href={`/tasks/${task.parent_task_id}`}
              className="font-mono hover:text-foreground transition-colors"
            >
              {shortId(task.parent_task_id)}
            </Link>
          </FooterField>
        ) : null}
      </footer>
    </DetailShell>
  );
}

function WorkProductCard({ wp }: { wp: WorkProduct }) {
  // Card → dedicated /work-products/[id] page where the body renders
  // full-width with markdown. We used to inline-expand here, but the
  // briefing bodies are real documents (audits, reports) — they want a
  // page, not a sliver of a card.
  return (
    <li>
      <Link
        href={`/work-products/${wp.id}`}
        className="rounded-lg border border-border bg-card p-3 flex items-start gap-3 hover:bg-secondary/30 transition-colors"
      >
        <FileText className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">{wp.title}</div>
          {wp.summary ? (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{wp.summary}</p>
          ) : null}
        </div>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0 mt-0.5">
          {wp.type.replace(/_/g, " ")}
        </span>
      </Link>
    </li>
  );
}

function SessionRow({ session, taskId }: { session: TaskDetailSessionRow; taskId: string }) {
  return (
    <li>
      <Link
        href={`/tasks/${taskId}/sessions/${session.short_id}`}
        className="block rounded-lg border border-border bg-card p-3 hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-2 mb-1">
          <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-mono text-xs">{session.short_id}</span>
          <span className="text-xs text-muted-foreground">{session.agent_label}</span>
          <SessionStatusPill status={session.status} className="ml-auto" />
        </div>
        {session.result_summary ? (
          <p className="text-xs text-muted-foreground line-clamp-2 mt-1">{session.result_summary}</p>
        ) : null}
        <div className="mt-1.5 text-[11px] text-muted-foreground/70 tabular-nums">
          {session.duration_label} · {formatRelativeTime(session.started_at)}
        </div>
      </Link>
    </li>
  );
}
