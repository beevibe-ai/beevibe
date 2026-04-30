"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Inbox } from "lucide-react";
import type { TaskStatus } from "@beevibe/core";
import { LifecycleTabs, type Lifecycle } from "@/components/tasks/lifecycle-tabs";
import { FilterBar } from "@/components/tasks/filter-bar";
import { TaskRow } from "@/components/tasks/task-row";
import { EmptyState } from "@/components/empty-state";
import { fixtureCounts, fixtureTasks, type TaskListItem } from "@/lib/fixtures/tasks";
import { cn } from "@/lib/utils";

const STATUS_PRIORITY: Record<TaskStatus, number> = {
  review: 0,
  blocked: 1,
  in_progress: 2,
  revision: 2,
  needs_revision: 2,
  assigned: 3,
  pending: 4,
  done: 5,
  failed: 6,
  cancelled: 7,
};

const ARCHIVED_STATUSES: readonly TaskStatus[] = ["done", "failed", "cancelled"];

function sortTasks(tasks: TaskListItem[]): TaskListItem[] {
  return [...tasks].sort((a, b) => {
    const sp = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (sp !== 0) return sp;
    return b.updated_at.getTime() - a.updated_at.getTime();
  });
}

export function TasksClient() {
  const [lifecycle, setLifecycle] = useState<Lifecycle>("active");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const lowerQuery = query.toLowerCase();
    const filtered = fixtureTasks.filter((t) => {
      if (lowerQuery && !t.title.toLowerCase().includes(lowerQuery)) return false;
      const archived = ARCHIVED_STATUSES.includes(t.status);
      if (lifecycle === "active") return !archived;
      if (lifecycle === "archive") return archived;
      return true;
    });
    return sortTasks(filtered);
  }, [lifecycle, query]);

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto pb-6">
        <LifecycleTabs
          current={lifecycle}
          counts={fixtureCounts}
          onChange={setLifecycle}
          onMineToReview={() => {}}
          onNewTask={() => {}}
        />

        <FilterBar query={query} onQueryChange={setQuery} />

        {visible.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="No tasks match"
            description={
              query
                ? `No ${lifecycle} tasks match "${query}".`
                : `No ${lifecycle} tasks right now.`
            }
          />
        ) : (
          <>
            <ul>
              {visible.map((t, i) => (
                <TaskRow key={t.id} task={t} flash={i === 0} />
              ))}
            </ul>
            <Pagination total={fixtureCounts.active} shown={visible.length} />
          </>
        )}
      </div>
    </div>
  );
}

function Pagination({ shown, total }: { shown: number; total: number }) {
  return (
    <div className="flex items-center justify-between px-6 py-3 mt-2 text-xs">
      <span className="text-muted-foreground">
        Showing <span className="text-foreground">1–{shown}</span> of{" "}
        <span className="text-foreground">{total}</span> active
      </span>
      <nav className="flex items-center gap-1" aria-label="Pagination">
        <button
          disabled
          aria-label="Previous page"
          className="h-7 w-7 rounded inline-flex items-center justify-center hover:bg-secondary cursor-pointer transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {[1, 2, 3].map((n) => (
          <button
            key={n}
            aria-label={`Page ${n}`}
            aria-current={n === 1 ? "page" : undefined}
            className={cn(
              "h-7 min-w-7 px-2 rounded cursor-pointer transition-colors",
              n === 1 ? "text-foreground bg-secondary font-medium" : "hover:bg-secondary",
            )}
          >
            {n}
          </button>
        ))}
        <button
          aria-label="Next page"
          className="h-7 w-7 rounded inline-flex items-center justify-center hover:bg-secondary cursor-pointer transition-colors"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </nav>
    </div>
  );
}
