import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Check, ChevronLeft, Moon, RotateCcw, Sun, X } from "lucide-react";
import { TaskStatusPill, PriorityPill, SessionStatusPill } from "@/components/detail/status-pill";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { HierChip } from "@/components/hier-chip";
import { RichTextRender } from "@/components/rich-text";
import { findTaskById } from "@/lib/fixtures/tasks";
import { formatRelativeTime, shortId } from "@/lib/format";

export function generateMetadata({ params }: { params: { id: string } }): Metadata {
  const task = findTaskById(params.id);
  return { title: task ? task.title : "Task" };
}

export default function TaskDetailPage({ params }: { params: { id: string } }) {
  const task = findTaskById(params.id);
  if (!task) notFound();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <Link
          href="/tasks"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Tasks
        </Link>

        <div className="flex items-start justify-between gap-6 mb-1.5">
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl leading-8 font-semibold tracking-tight">{task.title}</h1>
          </div>
          <div className="flex items-center gap-1.5 shrink-0 mt-1.5">
            <TaskStatusPill status={task.status} />
            <PriorityPill priority={task.priority} />
          </div>
        </div>

        <div className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap mb-5">
          <span>Created by</span>
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <span className="h-4 w-4 rounded-full bg-secondary border border-border flex items-center justify-center text-[10px] font-medium">
              {(task.creator_label ?? "?").charAt(0)}
            </span>
            {task.creator_label}
          </span>
          {task.assignee_label ? (
            <>
              <span className="text-border">·</span>
              <span>Assigned to</span>
              <span className="inline-flex items-center gap-1.5 text-foreground">
                <span className="font-mono text-xs">{task.assignee_label}</span>
                {task.assignee_hierarchy ? <HierChip hier={task.assignee_hierarchy} /> : null}
              </span>
            </>
          ) : null}
          <span className="text-border">·</span>
          <span>
            Updated <span className="text-foreground">{formatRelativeTime(task.updated_at)}</span>
          </span>
        </div>

        <div className="flex justify-end gap-2 mb-6">
          <button className="inline-flex items-center gap-2 h-9 px-3 rounded text-sm font-medium border border-border text-foreground hover:bg-secondary active:scale-[0.98] cursor-pointer transition-all duration-150">
            <X className="h-4 w-4" />
            Reject
          </button>
          <button className="inline-flex items-center gap-2 h-9 px-3 rounded text-sm font-medium border border-border text-foreground hover:bg-secondary active:scale-[0.98] cursor-pointer transition-all duration-150">
            <RotateCcw className="h-4 w-4" />
            Request revisions
          </button>
          <button className="inline-flex items-center gap-2 h-9 px-3 rounded text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 active:scale-[0.98] cursor-pointer transition-all duration-150">
            <Check className="h-4 w-4" />
            Approve
          </button>
        </div>

        <div className="border-b border-border mb-6">
          <div className="flex items-center gap-1 -mb-px">
            <button className="px-3 py-2.5 text-sm font-medium border-b-2 border-foreground text-foreground cursor-pointer">
              Overview
            </button>
            <button className="px-3 py-2.5 text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
              Sessions
              {task.session_count ? (
                <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded text-[10px] font-medium bg-secondary text-muted-foreground">
                  {task.session_count}
                </span>
              ) : null}
            </button>
            <button className="px-3 py-2.5 text-sm font-medium border-b-2 border-transparent text-muted-foreground hover:text-foreground cursor-pointer transition-colors">
              Work products
              {task.work_product_count ? (
                <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-[1rem] px-1 rounded text-[10px] font-medium bg-secondary text-muted-foreground">
                  {task.work_product_count}
                </span>
              ) : null}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-5">
            {task.description ? (
              <section className="rounded-lg border border-border bg-card p-5">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                  Description
                </h3>
                <div className="space-y-3 text-sm leading-6">
                  {task.description.map((p, i) => (
                    <p key={i}>
                      <RichTextRender value={p} />
                    </p>
                  ))}
                </div>
              </section>
            ) : null}

            {task.result_summary ? (
              <section className="rounded-lg border border-border bg-card p-5">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                  Result summary
                </h3>
                <div className="space-y-3 text-sm leading-6">
                  <p>
                    <RichTextRender value={task.result_summary} />
                  </p>
                </div>
              </section>
            ) : null}
          </div>

          <aside className="col-span-1 space-y-4">
            {task.latest_session ? (
              <section className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Latest session
                  </h3>
                  {task.session_count && task.session_count > 1 ? (
                    <span className="text-xs text-muted-foreground">View all {task.session_count}</span>
                  ) : null}
                </div>
                <Link
                  href={`/sessions/${task.latest_session.short_id}`}
                  className="block group -mx-1 -my-1 px-1 py-1 rounded hover:bg-secondary/60 transition-colors"
                >
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-mono text-xs text-foreground">{task.latest_session.short_id}…</span>
                    <SessionStatusPill status={task.latest_session.status} />
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {task.latest_session.elapsed} · {task.latest_session.agent_label}
                  </div>
                </Link>
              </section>
            ) : null}

            {task.status === "blocked" && task.blocker_reason ? (
              <section className="rounded-lg border border-status-blocked/30 bg-status-blocked/5 p-4">
                <h3 className="text-xs font-semibold text-status-blocked uppercase tracking-wider mb-2">
                  Blocker
                </h3>
                <p className="text-sm">{task.blocker_reason}</p>
              </section>
            ) : (
              <section className="rounded-lg border border-dashed border-border p-4 text-center">
                <div className="text-xs text-muted-foreground">No active blocker</div>
              </section>
            )}
          </aside>
        </div>

        <div className="mt-8 pt-4 border-t border-border flex items-center gap-3 text-xs text-muted-foreground">
          <ClickToCopyId id={task.id.replace(/^[a-z]+_/, "")} />
          <span className="text-border">·</span>
          <span>
            Created <span className="text-foreground">{formatRelativeTime(task.created_at)}</span>
          </span>
          <span className="text-border">·</span>
          <span>{task.parent_task_id ? `Parent ${shortId(task.parent_task_id)}` : "No parent task"}</span>
        </div>

        <div className="mt-12 text-xs text-muted-foreground flex items-center gap-3">
          <span className="font-mono">mock</span>
          <span className="text-border">·</span>
          <span>
            Honors prefers-color-scheme. Click the{" "}
            <Moon className="h-3 w-3 inline align-[-1px]" />/
            <Sun className="h-3 w-3 inline align-[-1px]" /> in the header to override.
          </span>
        </div>
      </div>
    </div>
  );
}
