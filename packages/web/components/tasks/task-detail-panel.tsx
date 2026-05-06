"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  ListChecks,
  Terminal,
  X,
} from "lucide-react";
import { ChatMarkdown } from "@/components/chat/markdown";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { TaskStatusPill, SessionStatusPill } from "@/components/detail/status-pill";
import { EmptyState } from "@/components/empty-state";
import { HierChip } from "@/components/hier-chip";
import { Skeleton } from "@/components/skeleton";
import { isApiConfigured } from "@/lib/api/config";
import { useTask } from "@/lib/hooks/use-tasks";
import {
  useApproveTask,
  useRejectTask,
  useReviseTask,
} from "@/lib/hooks/use-task-mutations";
import { formatRelativeTime, shortId } from "@/lib/format";
import { richTextToMarkdown, type RichText } from "@/components/rich-text";
import { cn } from "@/lib/utils";
import type { TaskDetail, TaskDetailSessionRow } from "@/lib/api/types";
import type { WorkProduct } from "@beevibe/core";

/**
 * Notion-style peek panel for a task. Anchored to the right of the
 * kanban it overlays; the board stays visible and interactable
 * underneath. Same pattern as AgentDetailPanel.
 *
 * Approve / reject / revise actions are surfaced inline when the task
 * is in review — letting the user clear their queue without leaving
 * the kanban context. Heavier deep-dive (work product bodies, session
 * transcripts) lives behind "Open full page".
 */
export function TaskDetailPanel({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);

  // Esc closes — same pattern as the agent peek and the rest of the
  // dialog/drawer surfaces.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Click-outside closes. Listener attaches on mount, so the click that
  // *opened* the panel (which fired before the panel rendered) doesn't
  // race-trigger close. Any subsequent mousedown outside the aside
  // fires onClose.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (e.target instanceof Node && panel.contains(e.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-label="Task details"
      className="absolute right-0 top-0 bottom-0 w-[520px] max-w-full bg-card border-l border-border shadow-xl flex flex-col z-20"
    >
      <PanelHeader taskId={taskId} onClose={onClose} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <PanelBody taskId={taskId} />
      </div>
    </aside>
  );
}

function PanelHeader({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 h-11 border-b border-border/60 shrink-0">
      <Link
        href={`/tasks/${taskId}`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ExternalLink className="h-3 w-3" />
        Open full page
      </Link>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close panel"
        title="Close (Esc)"
        className="h-7 w-7 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary cursor-pointer transition-colors"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function PanelBody({ taskId }: { taskId: string }) {
  const { data, isLoading, isError } = useTask(taskId);

  if (!isApiConfigured) {
    return (
      <div className="p-4">
        <EmptyState
          icon={ListChecks}
          title="API not configured"
          description="Set NEXT_PUBLIC_BV_API_URL to load this task."
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-5 space-y-4">
        <Skeleton className="h-7 w-3/4" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-4">
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load task"
          description={`Task ${taskId} could not be fetched.`}
        />
      </div>
    );
  }

  return <PanelLoaded task={data} />;
}

function PanelLoaded({ task }: { task: TaskDetail }) {
  const isInReview = task.status === "review";
  const activeSession =
    task.latest_session?.status === "running" ? task.latest_session : null;

  return (
    <div className="px-5 py-5">
      <header>
        <div className="flex items-start gap-3">
          <h2 className="text-base font-semibold leading-snug flex-1 min-w-0">
            {task.title}
          </h2>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <TaskStatusPill status={task.status} />
            {task.assignee_hierarchy && task.assignee_hierarchy !== "ic" ? (
              <HierChip hier={task.assignee_hierarchy} />
            ) : null}
          </div>
        </div>

        {/* Compact metadata row beneath the title — mirrors the
            kanban-card treatment so the panel feels continuous with
            the card the user just clicked. */}
        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          {task.assignee_label ? (
            <span className="font-mono text-foreground/80 truncate">
              {task.assignee_label}
            </span>
          ) : null}
          <span className="text-muted-foreground/50">·</span>
          <span className="tabular-nums">{formatRelativeTime(task.updated_at)}</span>
          <span className="text-muted-foreground/50">·</span>
          <span className="capitalize">{task.priority}</span>
        </div>
      </header>

      {isInReview ? <ReviewActions task={task} /> : null}

      {task.status === "blocked" && task.blocker_reason ? (
        <Section title="Blocked" tone="blocked">
          <p className="text-sm text-foreground">{task.blocker_reason}</p>
        </Section>
      ) : null}

      <DescriptionSection description={task.description} />

      {task.result_summary ? (
        <Section title="Result summary">
          <div className="text-foreground/85">
            <ChatMarkdown content={richTextToMarkdown(task.result_summary)} />
          </div>
        </Section>
      ) : null}

      {activeSession ? (
        <Section title="Active session">
          <Link
            href={`/tasks/${task.id}/sessions/${activeSession.short_id}`}
            className="flex items-center gap-2 rounded-md border border-border/70 bg-background/40 px-2.5 py-1.5 hover:bg-secondary/30 transition-colors"
          >
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-mono text-xs">{activeSession.short_id}</span>
            <SessionStatusPill status="running" className="ml-auto" />
            <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
              {activeSession.elapsed}
            </span>
          </Link>
        </Section>
      ) : null}

      <Section
        title="Work products"
        count={task.work_products.length}
        empty="No work products yet."
      >
        {task.work_products.length > 0 ? (
          <ul className="space-y-1.5">
            {task.work_products.map((wp) => (
              <WorkProductRow key={wp.id} wp={wp} />
            ))}
          </ul>
        ) : null}
      </Section>

      <Section
        title="Sessions"
        count={task.sessions.length}
        empty="No sessions yet."
      >
        {task.sessions.length > 0 ? (
          <ul className="space-y-1.5">
            {task.sessions.map((s) => (
              <SessionRow key={s.id} session={s} taskId={task.id} />
            ))}
          </ul>
        ) : null}
      </Section>

      <footer className="mt-6 pt-4 border-t border-border/60 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] text-muted-foreground">
        <PanelFooterField label="ID">
          <ClickToCopyId id={task.id} />
        </PanelFooterField>
        <PanelFooterField label="Priority">{task.priority}</PanelFooterField>
        <PanelFooterField label="Created">
          {formatRelativeTime(task.created_at)}
        </PanelFooterField>
        <PanelFooterField label="Updated">
          {formatRelativeTime(task.updated_at)}
        </PanelFooterField>
        {task.creator_label ? (
          <PanelFooterField label="Creator">{task.creator_label}</PanelFooterField>
        ) : null}
        {task.parent_task_id ? (
          <PanelFooterField label="Parent">
            <Link
              href={`/tasks/${task.parent_task_id}`}
              className="font-mono hover:text-foreground transition-colors"
            >
              {shortId(task.parent_task_id)}
            </Link>
          </PanelFooterField>
        ) : null}
      </footer>
    </div>
  );
}

// ── Description (markdown + collapse) ────────────────────────────────

const DESCRIPTION_COLLAPSE_THRESHOLD = 500;

function DescriptionSection({ description }: { description: RichText[] | undefined }) {
  const markdown =
    description && description.length > 0
      ? description.map(richTextToMarkdown).join("\n\n")
      : "";
  const long = markdown.length > DESCRIPTION_COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!long);
  const visible =
    long && !expanded
      ? markdown.slice(0, DESCRIPTION_COLLAPSE_THRESHOLD).trimEnd() + "…"
      : markdown;

  return (
    <Section title="Description">
      {markdown ? (
        <>
          <div className="text-foreground/85">
            <ChatMarkdown content={visible} />
          </div>
          {long && !expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              Show more
            </button>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground italic">No description.</p>
      )}
    </Section>
  );
}

// ── Sections + helpers ───────────────────────────────────────────────

function Section({
  title,
  count,
  empty,
  tone,
  children,
}: {
  title: string;
  count?: number;
  empty?: string;
  tone?: "blocked";
  children: React.ReactNode;
}) {
  const isEmpty = count === 0;
  return (
    <section
      className={cn(
        "mt-5",
        tone === "blocked" && "rounded-md border border-status-blocked/40 bg-status-blocked/5 p-3 -mx-1",
      )}
    >
      <h3
        className={cn(
          "text-[10px] uppercase tracking-wider mb-2 font-semibold",
          tone === "blocked" ? "text-status-blocked" : "text-muted-foreground/85",
        )}
      >
        {title}
        {count !== undefined ? (
          <span className="ml-1 text-muted-foreground/70 tabular-nums font-normal">
            {count}
          </span>
        ) : null}
      </h3>
      {isEmpty && empty ? (
        <p className="text-xs text-muted-foreground italic">{empty}</p>
      ) : (
        children
      )}
    </section>
  );
}

function PanelFooterField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="uppercase tracking-wider text-muted-foreground/70 mb-0.5 text-[10px]">
        {label}
      </div>
      <div className="text-foreground/85 truncate">{children}</div>
    </div>
  );
}

function WorkProductRow({ wp }: { wp: WorkProduct }) {
  return (
    <li>
      <Link
        href={`/work-products/${wp.id}`}
        className="flex items-start gap-2 rounded-md border border-border/70 bg-background/40 px-2.5 py-1.5 hover:bg-secondary/30 transition-colors"
      >
        <FileText className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{wp.title}</div>
          {wp.summary ? (
            <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">
              {wp.summary}
            </p>
          ) : null}
        </div>
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground shrink-0 mt-0.5">
          {wp.type.replace(/_/g, " ")}
        </span>
      </Link>
    </li>
  );
}

function SessionRow({
  session,
  taskId,
}: {
  session: TaskDetailSessionRow;
  taskId: string;
}) {
  return (
    <li>
      <Link
        href={`/tasks/${taskId}/sessions/${session.short_id}`}
        className="block rounded-md border border-border/70 bg-background/40 px-2.5 py-1.5 hover:bg-secondary/30 transition-colors"
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          <Terminal className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono text-[11px]">{session.short_id}</span>
          <span className="text-[11px] text-muted-foreground truncate">
            {session.agent_label}
          </span>
          <SessionStatusPill status={session.status} className="ml-auto" />
        </div>
        {session.result_summary ? (
          <p className="text-[11px] text-muted-foreground line-clamp-2 mt-1">
            {session.result_summary}
          </p>
        ) : null}
        <div className="mt-1 text-[10px] text-muted-foreground/70 tabular-nums">
          {session.duration_label} · {formatRelativeTime(session.started_at)}
        </div>
      </Link>
    </li>
  );
}

// ── Review actions ──────────────────────────────────────────────────

function ReviewActions({ task }: { task: TaskDetail }) {
  const approve = useApproveTask(task.id);
  const reject = useRejectTask(task.id);
  const revise = useReviseTask(task.id);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [feedback, setFeedback] = useState("");

  const anyPending = approve.isPending || reject.isPending || revise.isPending;
  const lastError =
    approve.error ?? reject.error ?? revise.error ?? null;

  const submit = () => {
    const fb = feedback.trim();
    if (!fb) return;
    revise.mutate(
      { feedback: fb },
      {
        onSuccess: () => {
          setFeedback("");
          setReviseOpen(false);
        },
      },
    );
  };

  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={anyPending}
          onClick={() => approve.mutate({})}
          className="flex-1 h-8 px-3 rounded text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {approve.isPending ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          disabled={anyPending}
          onClick={() => setReviseOpen((v) => !v)}
          className="h-8 px-3 rounded text-xs font-medium border border-border hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Revise
        </button>
        <button
          type="button"
          disabled={anyPending}
          onClick={() => reject.mutate({})}
          className="h-8 px-3 rounded text-xs font-medium border border-border hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {reject.isPending ? "Rejecting…" : "Reject"}
        </button>
      </div>
      {reviseOpen ? (
        <div className="rounded-md border border-border bg-background/40 p-2.5 space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="What needs to change?"
            rows={3}
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setReviseOpen(false);
                setFeedback("");
              }}
              className="h-7 px-2.5 rounded text-[11px] font-medium border border-border hover:bg-secondary transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={anyPending || feedback.trim().length === 0}
              onClick={submit}
              className="h-7 px-2.5 rounded text-[11px] font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {revise.isPending ? "Submitting…" : "Submit"}
            </button>
          </div>
        </div>
      ) : null}
      {lastError ? (
        <p className="text-[11px] text-status-failed">
          Action failed: {lastError.message}
        </p>
      ) : null}
    </div>
  );
}
