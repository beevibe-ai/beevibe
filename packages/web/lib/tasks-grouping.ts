/**
 * The board's lanes: which tasks go in which column, and how each column
 * is labelled and coloured.
 *
 * The *vocabulary* — the six lanes and the status → lane map — is no
 * longer declared here. It lives in `@beevibe/core/domain/task-lifecycle`,
 * because the api needs the same map to back `GET /task?lifecycle=` and
 * the copy it kept for that had drifted two lanes behind this file. What
 * stays here is the part that is genuinely web-only: lane order, labels,
 * and the Tailwind dot classes.
 */

import {
  TASK_LIFECYCLE_OF,
  type TaskLifecycle,
} from "@beevibe/core/domain/task-lifecycle";
import type { TaskListItem } from "@/lib/types/tasks";
import type { BoardLane } from "@/components/tasks/board-column";

/** Local alias for the canonical lane union — `@/lib/tasks-grouping`'s
 * existing import sites (`board-column`, `lib/api/client`) spell it
 * `Lifecycle`. */
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

/**
 * Count of tasks in the Archived lane — drives the "X archived" toggle.
 * Reads the lane map rather than re-testing `failed`/`cancelled` by hand,
 * so the number on the toggle can't disagree with the lane it opens.
 */
export function countArchivedTasks(tasks: TaskListItem[]): number {
  let n = 0;
  for (const t of tasks) {
    if (TASK_LIFECYCLE_OF[t.status] === "archived") n += 1;
  }
  return n;
}
