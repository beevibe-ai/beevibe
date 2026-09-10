/**
 * Board grouping. The lifecycle vocabulary — the lanes and the status →
 * lane mapping — comes from `@beevibe/core/domain/task`, which the api
 * reads too; this file owns only the presentation (order, labels, dot
 * colors) and the bucketing.
 *
 * The mapping used to be declared here *and*, differently, in
 * `packages/api/src/views/tasks-grouping.ts`, with both feeding the same
 * `?lifecycle=` wire parameter. See `TaskLifecycle` in core for what the
 * drift broke.
 *
 * Imported from the `domain/task` subpath, not the package root: the root
 * barrel re-exports `./auth`, which reaches for `node:crypto`, and this
 * module is pulled into a client component. Same reason
 * `@beevibe/core/domain/format` has its own subpath.
 */

import {
  TASK_LIFECYCLE_OF_STATUS,
  type TaskLifecycle,
} from "@beevibe/core/domain/task";
import type { TaskListItem } from "@/lib/types/tasks";
import type { BoardLane } from "@/components/tasks/board-column";

/** The web's historical name for core's `TaskLifecycle`. */
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
  for (const t of tasks) buckets[TASK_LIFECYCLE_OF_STATUS[t.status]].push(t);
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
 * "X archived" toggle. Keyed off the shared mapping rather than a status
 * literal so it can't disagree with which lane `groupTasks` hides.
 */
export function countArchivedTasks(tasks: TaskListItem[]): number {
  let n = 0;
  for (const t of tasks) {
    if (TASK_LIFECYCLE_OF_STATUS[t.status] === "archived") n += 1;
  }
  return n;
}
