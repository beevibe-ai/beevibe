import type { TaskStatus } from "@beevibe/core";
import type { TaskListItem } from "@/lib/types/tasks";
import type { BoardLane } from "@/components/tasks/board-column";

export type Lifecycle =
  | "pending"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "archived";

/**
 * Status → lifecycle lane.
 *
 * - `blocked` lives in its own lane (was previously folded into
 *   In review). Blocked = waiting on an external dependency, semantically
 *   different from "waiting on a human verdict." Different action by the
 *   human reading the board, so different column.
 * - `failed` and `cancelled` are terminal states that aren't success.
 *   They go into the `archived` lane, hidden by default — `Done` should
 *   read as "this shipped." Archive toggle exposes them when the user
 *   wants to see what didn't ship.
 */
const LIFECYCLE_OF: Record<TaskStatus, Lifecycle> = {
  pending: "pending",
  assigned: "pending",
  in_progress: "in_progress",
  revision: "in_progress",
  needs_revision: "in_progress",
  review: "in_review",
  blocked: "blocked",
  done: "done",
  failed: "archived",
  cancelled: "archived",
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

const ARCHIVED_LANE: LaneTemplate = {
  key: "archived",
  label: "Archived",
  dot: "bg-muted-foreground/40",
};

interface GroupOptions {
  /** Append the Archived lane (failed + cancelled). Default: false. */
  showArchived?: boolean;
}

export function groupTasks(
  tasks: TaskListItem[],
  options: GroupOptions = {},
): BoardLane[] {
  const buckets: Record<Lifecycle, TaskListItem[]> = {
    pending: [],
    in_progress: [],
    blocked: [],
    in_review: [],
    done: [],
    archived: [],
  };
  for (const t of tasks) buckets[LIFECYCLE_OF[t.status]].push(t);
  const template = options.showArchived
    ? [...VISIBLE_LANES, ARCHIVED_LANE]
    : VISIBLE_LANES;
  return template.map((l) => ({
    ...l,
    count: buckets[l.key].length,
    tasks: buckets[l.key],
  }));
}

/** Count of failed+cancelled tasks — drives the "X archived" toggle. */
export function countArchivedTasks(tasks: TaskListItem[]): number {
  let n = 0;
  for (const t of tasks) {
    if (t.status === "failed" || t.status === "cancelled") n += 1;
  }
  return n;
}
