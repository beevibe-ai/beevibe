import type { TaskStatus } from "@beevibe/core";
import type { TaskListItem } from "@/lib/types/tasks";
import type { BoardLane } from "@/components/tasks/board-column";

export type Lifecycle =
  | "pending"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done";

/**
 * Status → lifecycle lane (or `null` to omit from the board entirely).
 *
 * `blocked` lives in its own lane (was previously folded into In review).
 * Blocked = waiting on an external dependency, semantically different from
 * "waiting on a human verdict" — different action by the human reading
 * the board, so different column.
 *
 * `failed` and `cancelled` are terminal non-success statuses. They are
 * omitted from the board so `Done` reads as "this shipped." The header's
 * archived badge surfaces the count for awareness, but the board itself
 * stays focused on in-flight + shipped work.
 */
const LIFECYCLE_OF: Record<TaskStatus, Lifecycle | null> = {
  pending: "pending",
  assigned: "pending",
  in_progress: "in_progress",
  revision: "in_progress",
  needs_revision: "in_progress",
  review: "in_review",
  blocked: "blocked",
  done: "done",
  failed: null,
  cancelled: null,
};

interface LaneTemplate {
  key: Lifecycle;
  label: string;
  dot: string;
}

// Workflow-order, left-to-right. Blocked sits between In progress and
// In review because that's where blockers actually arise — work
// started, hit an impasse, needs unblocking before it can land in
// review.
const VISIBLE_LANES: LaneTemplate[] = [
  { key: "pending", label: "Pending", dot: "bg-muted-foreground/50" },
  { key: "in_progress", label: "In progress", dot: "bg-status-running" },
  { key: "blocked", label: "Blocked", dot: "bg-status-blocked" },
  { key: "in_review", label: "In review", dot: "bg-status-review" },
  { key: "done", label: "Done", dot: "bg-status-done" },
];

export function groupTasks(tasks: TaskListItem[]): BoardLane[] {
  const buckets: Record<Lifecycle, TaskListItem[]> = {
    pending: [],
    in_progress: [],
    blocked: [],
    in_review: [],
    done: [],
  };
  for (const t of tasks) {
    const lane = LIFECYCLE_OF[t.status];
    if (lane) buckets[lane].push(t);
  }
  return VISIBLE_LANES.map((l) => ({
    ...l,
    count: buckets[l.key].length,
    tasks: buckets[l.key],
  }));
}

/** Count of failed+cancelled tasks — drives the archived badge in the header. */
export function countArchivedTasks(tasks: TaskListItem[]): number {
  let n = 0;
  for (const t of tasks) {
    if (t.status === "failed" || t.status === "cancelled") n += 1;
  }
  return n;
}
