import {
  TASK_LIFECYCLE_OF,
  type TaskLifecycle,
} from "@beevibe/core/domain/task-lifecycle";
import type { TaskListItem } from "@/lib/types/tasks";
import type { BoardLane } from "@/components/tasks/board-column";

/**
 * Board grouping. The status → lane map is `TASK_LIFECYCLE_OF` in core's
 * domain layer, shared with the api's `?lifecycle=` filter (which coarsens
 * these six lanes into four wire keys); what stays here is the
 * presentation — which lanes are visible, their order, their labels and
 * dot colours.
 */

/** Re-exported under the local name the board's components import. */
export type Lifecycle = TaskLifecycle;

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
  for (const t of tasks) buckets[TASK_LIFECYCLE_OF[t.status]].push(t);
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
