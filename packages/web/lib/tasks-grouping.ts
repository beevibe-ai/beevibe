/**
 * Board lane grouping for the task list.
 *
 * The taxonomy itself — which status belongs to which lane — lives in
 * `@beevibe/core` (`TaskLifecycle` / `TASK_LIFECYCLE_OF`), because the
 * server filters `GET /task?lifecycle=` on the same mapping. This module
 * was previously a parallel declaration of it, and the two had drifted:
 * the server still folded `blocked` into In review and `failed` /
 * `cancelled` into Done, so a `?lifecycle=` deep link returned rows this
 * board then painted into a different lane. Only the presentation below
 * (labels, dot colors, lane order on screen) is web-owned.
 */

import { TASK_LIFECYCLE_OF, type TaskLifecycle } from "@beevibe/core";
import type { TaskListItem } from "@/lib/types/tasks";
import type { BoardLane } from "@/components/tasks/board-column";

interface LaneTemplate {
  key: TaskLifecycle;
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
  const buckets: Record<TaskLifecycle, TaskListItem[]> = {
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
 * Count of tasks in the archived lane (failed + cancelled) — drives the
 * "X archived" toggle. Reads the lane off the shared taxonomy rather than
 * naming the statuses, so it tracks `TASK_LIFECYCLE_OF` automatically.
 */
export function countArchivedTasks(tasks: TaskListItem[]): number {
  let n = 0;
  for (const t of tasks) {
    if (TASK_LIFECYCLE_OF[t.status] === "archived") n += 1;
  }
  return n;
}
