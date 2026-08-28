"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  FileText,
  ListChecks,
  MessageSquare,
  Package,
  Terminal,
} from "lucide-react";
import { api } from "@/lib/api/client";
import { useTask } from "@/lib/hooks/use-tasks";
import {
  useApproveTask,
  useRejectTask,
  useReviseTask,
} from "@/lib/hooks/use-task-mutations";
import { TaskLifecycleActions } from "@/components/tasks/task-lifecycle-actions";
import { isTerminalTaskStatus } from "@/lib/task-status";
import { TaskStatusPill, SessionStatusPill } from "@/components/detail/status-pill";
import { ChatMarkdown } from "@/components/chat/markdown";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { BackLink } from "@/components/detail/back-link";
import { DetailGate } from "@/components/detail/detail-gate";
import { FooterField } from "@/components/detail/footer-field";
import { HierChip } from "@/components/hier-chip";
import { Skeleton } from "@/components/skeleton";
import { richTextToMarkdown } from "@/components/rich-text";
import { formatRelativeTime, shortId } from "@/lib/format";
import { slugify } from "@/lib/capabilities";
import type { TaskDetail, TaskDetailSessionRow } from "@/lib/api/types";
import type { ReferencedRepo } from "@/lib/api/client";
import type { WorkProduct } from "@beevibe/core";

export function TaskDetailClient({ taskId }: { taskId: string }) {
  const query = useTask(taskId);

  return (
    <DetailGate
      nav={<BackLink href="/tasks" label="Tasks" className="mb-3" />}
      icon={ListChecks}
      noun="task"
      id={taskId}
      query={query}
      skeleton={
        <>
          <Skeleton className="h-8 w-2/3 mb-2" />
          <Skeleton className="h-4 w-1/3 mb-6" />
          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2 space-y-4">
              <Skeleton className="h-32 w-full rounded-lg" />
              <Skeleton className="h-24 w-full rounded-lg" />
            </div>
            <Skeleton className="h-40 w-full rounded-lg" />
          </div>
        </>
      }
    >
      {(data) => <TaskDetailLoaded task={data} />}
    </DetailGate>
  );
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

function TaskDetailLoaded({ task }: { task: TaskDetail }) {
  const isInReview = task.status === "review";
  const isTerminal = isTerminalTaskStatus(task.status);
  const activeSession = task.latest_session?.status === "running" ? task.latest_session : null;
  const approve = useApproveTask(task.id);
  const reject = useRejectTask(task.id);
  const revise = useReviseTask(task.id);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [reviseFeedback, setReviseFeedback] = useState("");

  // Review actions in flight gate each other AND the lifecycle Cancel
  // button (passed via `extraDisabled` to TaskLifecycleActions) — if
  // cancel raced with an in-flight approve/reject, the task could end
  // up in a weird mid-transition state.
  const { anyPending: reviewPending, lastError, lastErrorAction } = reviewStatus({ approve, reject, revise });

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
    <>
      <header className="mb-6">
        <div className="flex items-start justify-between gap-6 mb-2">
          <h1 className="text-base font-semibold tracking-tight leading-tight flex-1 min-w-0">{task.title}</h1>
          <div className="flex items-center gap-1.5 mt-1.5 shrink-0">
            <TaskStatusPill status={task.status} />
            {task.assignee_hierarchy ? <HierChip hier={task.assignee_hierarchy} /> : null}
          </div>
        </div>
        <TaskLifecycleActions task={task} extraDisabled={reviewPending} />

        {isInReview ? (
          <>
            <div className="flex justify-end gap-2 mb-2">
              <button
                type="button"
                disabled={reviewPending}
                onClick={() => reject.mutate({})}
                className="h-9 px-3 rounded text-sm font-medium border border-border hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {reject.isPending ? "Rejecting…" : "Reject"}
              </button>
              <button
                type="button"
                disabled={reviewPending}
                onClick={() => setReviseOpen((v) => !v)}
                className="h-9 px-3 rounded text-sm font-medium border border-border hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Request revision
              </button>
              <button
                type="button"
                disabled={reviewPending}
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
                    disabled={reviewPending || reviseFeedback.trim().length === 0}
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

      {task.status === "blocked" && task.blocker_reason ? (
        <BlockedReplyBanner task={task} />
      ) : null}

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

          {isTerminal ? <ReferencedReposCard taskId={task.id} taskTitle={task.title} /> : null}

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
    </>
  );
}

/**
 * Full-width banner shown above the description when a task is blocked.
 *
 * The blocker_reason is whatever the child agent wrote in their
 * `report_blocker` call — frequently structured questions for the human
 * (Q1/Q2/Q3 with bold markdown), so ChatMarkdown is the right renderer
 * here rather than the plain `<p>` the right-aside used.
 *
 * "Reply to agent" hands the conversation to the Team agent chat with a
 * pre-filled draft containing the task short_id + the blocker text. The
 * Team agent is the agent's direct parent in the mesh hierarchy, so
 * once it reads the user's answer it can call `revise_task` itself to
 * unblock the child — the same path the autonomous mesh.reportBlocker
 * spawn would have taken, just now informed by the user's input.
 */
const LIST_ITEM_RE = /^(?:\d+[.)]\s+|[-*•]\s+)(.+)$/;

/**
 * Extract a list of answer options from a blocker_reason. Agents
 * frequently call report_blocker with one or more multiple-choice
 * questions like:
 *
 *     Q1 — Where does the canonical CLAUDE.md live?
 *     - (a) Global ~/.claude/CLAUDE.md
 *     - (b) A specific project's ./CLAUDE.md
 *     - (c) Both — layered setup
 *     - (d) Neither — greenfield
 *
 *     Q2 — ...prose follow-up...
 *
 * We can't anchor to the tail because Q2 / closing prose comes AFTER
 * the options. Instead: find every contiguous run of list items in
 * the text and take the FIRST run that's chip-sized (2–4 items).
 * That naturally captures the canonical answer set for the first
 * multiple-choice question; the user can hit "Reply in chat →" for
 * any free-form follow-ups (Q2/Q3) that don't fit the chip pattern.
 *
 * Each item splits into a short `label` (for the chip button) and the
 * full `option` text (for the outbound message to the team agent).
 */
function parseBlockerOptions(reason: string | undefined): Array<{ label: string; option: string }> {
  if (!reason) return [];
  const lines = reason.split("\n").map((l) => l.trim());

  // Find all contiguous list-item groups, picking the first 2-4 sized.
  let target: string[] | undefined;
  let current: string[] = [];
  for (const line of lines) {
    if (LIST_ITEM_RE.test(line)) {
      current.push(line);
    } else {
      if (current.length >= 2 && current.length <= 4) {
        target = current;
        break;
      }
      current = [];
    }
  }
  if (!target && current.length >= 2 && current.length <= 4) target = current;
  if (!target) return [];

  return target
    .map((line) => {
      const m = LIST_ITEM_RE.exec(line);
      if (!m || !m[1]) return null;
      const text = m[1].trim().replace(/^\*\*(.+)\*\*$/, "$1");
      // For the chip label: take the first clause up to a clear
      // separator, strip markdown formatting (backticks especially —
      // they look ugly on a chip).
      const labelEnd = text.search(/[.—–]/);
      const labelRaw = (labelEnd === -1 ? text : text.slice(0, labelEnd)).trim();
      const label = labelRaw.replace(/`/g, "").trim().slice(0, 64);
      return label.length > 0 ? { label, option: text } : null;
    })
    .filter((x): x is { label: string; option: string } => x !== null);
}

function BlockedReplyBanner({ task }: { task: TaskDetail }) {
  const blocker = task.blocker_reason ?? "";
  const options = parseBlockerOptions(blocker);

  // Each chip click drops the user into chat with a one-line reply
  // already drafted AND auto-sent. The chat client reads the `send=1`
  // param and submits on mount. The team agent dereferences the task
  // id from the message, fetches the blocker context, and routes the
  // answer back to the blocked specialist via revise_task.
  const chipHref = (option: string) => {
    const draft = `Reply to ${task.id}: ${option}`;
    return `/chat?new=1&send=1&draft=${encodeURIComponent(draft)}`;
  };
  const freeFormHref = `/chat?new=1&draft=${encodeURIComponent(`Reply to ${task.id}: `)}`;

  return (
    <section className="mb-6 rounded-lg border border-status-blocked/40 bg-status-blocked/5 p-4">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="h-3.5 w-3.5 text-status-blocked" />
        <h3 className="text-[11px] uppercase tracking-wider text-status-blocked font-medium">
          Blocked — agent is asking you something
        </h3>
      </div>
      <div className="text-sm text-foreground/90">
        <ChatMarkdown content={blocker} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((opt) => (
          <Link
            key={opt.option}
            href={chipHref(opt.option)}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium bg-status-blocked/15 text-status-blocked hover:bg-status-blocked/25 transition-colors cursor-pointer"
            title={opt.option}
          >
            {opt.label}
          </Link>
        ))}
        <Link
          href={freeFormHref}
          className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium text-status-blocked/80 hover:text-status-blocked hover:bg-status-blocked/10 transition-colors cursor-pointer"
        >
          <MessageSquare className="h-3 w-3" />
          {options.length > 0 ? "Or reply in chat →" : "Reply in chat →"}
        </Link>
      </div>
    </section>
  );
}

/**
 * Renders on terminal tasks when the agent referenced GitHub repos
 * inside the transcript but never called `use_repo` itself (audit-style
 * tasks). Clicking "Validate & save" kicks off a real use_repo sandbox
 * run so the repo can be promoted to a learned skill.
 */
function ReferencedReposCard({ taskId, taskTitle }: { taskId: string; taskTitle: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["task", taskId, "referenced-repos"],
    queryFn: ({ signal }) => api.capabilities.referencedRepos(taskId, { signal }),
    staleTime: 60_000,
  });

  if (isLoading || !data || data.repos.length === 0) return null;

  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3 font-medium">
        Save as team capability{" "}
        <span className="text-muted-foreground/70 tabular-nums">{data.repos.length}</span>
      </h2>
      <p className="text-xs text-muted-foreground mb-3">
        Repos this task touched. Validate and save one so future agents can pick it up.
      </p>
      <ul className="space-y-2">
        {data.repos.map((repo) => (
          <ReferencedRepoRow key={repo.url} repo={repo} taskTitle={taskTitle} />
        ))}
      </ul>
    </section>
  );
}

function ReferencedRepoRow({ repo, taskTitle }: { repo: ReferencedRepo; taskTitle: string }) {
  const [runUrl, setRunUrl] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: () =>
      api.capabilities.use({
        repo_url: repo.url,
        goal: taskTitle,
      }),
    onSuccess: (res) => setRunUrl(res.watch_url),
  });

  return (
    <li className="rounded-lg border border-border/40 bg-card p-3 flex items-center gap-3">
      <Package className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <Link
          href={repo.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium hover:underline"
        >
          {repo.owner}/{repo.name}
        </Link>
        <p className="text-[11px] text-muted-foreground">
          {repo.occurrences === 1 ? "1 mention" : `${repo.occurrences} mentions`}
          {repo.already_saved ? " · already saved" : ""}
        </p>
      </div>
      {repo.already_saved ? (
        <span className="text-[11px] text-muted-foreground shrink-0">Saved</span>
      ) : runUrl ? (
        <Link
          href={runUrl}
          className="shrink-0 rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-medium hover:opacity-90 transition-opacity"
        >
          Watch run →
        </Link>
      ) : (
        <button
          onClick={() => run.mutate()}
          disabled={run.isPending}
          className="shrink-0 rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {run.isPending ? "Starting…" : "Validate & save"}
        </button>
      )}
    </li>
  );
}

function WorkProductCard({ wp }: { wp: WorkProduct }) {
  const isRepoArtifact = wp.type === "artifact" && typeof (wp.metadata as Record<string, unknown> | undefined)?.repo_run_id === "string";
  const repoRunId = isRepoArtifact ? (wp.metadata as Record<string, unknown>).repo_run_id as string : undefined;
  const [showSave, setShowSave] = useState(false);

  return (
    <li>
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <Link
          href={`/work-products/${wp.id}`}
          className="p-3 flex items-start gap-3 hover:bg-secondary/30 transition-colors block"
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
        {isRepoArtifact && repoRunId && (
          <div className="bg-muted/30 px-3 py-2.5 flex items-center gap-3">
            <Package className="h-4 w-4 text-foreground/70 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium">Came from a repo run</p>
              <p className="text-[11px] text-muted-foreground">
                Save the recipe so your agents can rerun this in seconds.
              </p>
            </div>
            <button
              onClick={() => setShowSave(true)}
              className="shrink-0 rounded-md bg-foreground text-background px-3 py-1.5 text-xs font-medium hover:opacity-90 transition-opacity"
            >
              Save as capability
            </button>
            <Link
              href={`/capabilities/runs/${repoRunId}`}
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              View run →
            </Link>
          </div>
        )}
      </div>
      {showSave && repoRunId && (
        <SaveAsCapabilityModal
          repoRunId={repoRunId}
          initialName={slugify(wp.title)}
          initialGoal={wp.summary ?? wp.title}
          onClose={() => setShowSave(false)}
        />
      )}
    </li>
  );
}


function SaveAsCapabilityModal({
  repoRunId,
  initialName,
  initialGoal,
  onClose,
}: {
  repoRunId: string;
  initialName: string;
  initialGoal: string;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [goal, setGoal] = useState(initialGoal);
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api.learnedSkills.create({ name, goal_pattern: goal, repo_run_id: repoRunId }),
    onSuccess: () => setDone(true),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-card border rounded-lg shadow-xl w-full max-w-md mx-4 p-6">
        <h2 className="text-base font-semibold mb-1">Save as capability</h2>
        <p className="text-xs text-muted-foreground mb-4">
          Remember this recipe so your agents can reuse it on similar tasks.
        </p>
        {done ? (
          <div className="space-y-3">
            <p className="text-sm text-green-600 dark:text-green-400">
              ✓ Saved as <strong>{name}</strong>.
            </p>
            <Link
              href="/capabilities"
              className="block text-center w-full rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
            >
              View in Capabilities →
            </Link>
            <button
              onClick={onClose}
              className="w-full rounded-md border px-4 py-2 text-sm hover:bg-muted transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <form
            onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
            className="space-y-4"
          >
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                Capability name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="extract-pdf-tables"
                pattern="[a-z0-9-]{2,64}"
                required
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground mt-1">
                A short slug — lowercase letters, numbers, hyphens.
              </p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground block mb-1">
                When should this trigger?
              </label>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={3}
                placeholder="e.g. when the user wants to extract tables from a PDF"
                required
                className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Describe the situation in plain language. Agents match this to incoming tasks.
              </p>
            </div>
            {save.error && (
              <p className="text-xs text-red-500">
                {save.error instanceof Error ? save.error.message : "Save failed"}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-md border px-4 py-2 text-sm hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={save.isPending}
                className="flex-1 rounded-md bg-foreground text-background px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {save.isPending ? "Saving…" : "Save to library"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
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
