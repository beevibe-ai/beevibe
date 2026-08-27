import { TASK_LIFECYCLE_OF, TASK_LIFECYCLES, type TaskLifecycle } from "@beevibe/core";
import type { TaskListItem } from "@/lib/types/tasks";
import type { BoardLane } from "@/components/tasks/board-column";

/**
 * Board grouping. The status → lane mapping itself lives in
 * `@beevibe/core`'s `domain/task-lifecycle.ts`, where the api reads the
 * same one to resolve `GET /task?lifecycle=` into a status set. It used to
 * be duplicated here and in `packages/api/src/views/tasks-grouping.ts`, and
 * the two had drifted: the api folded `blocked` into In review and
 * `failed`/`cancelled` into Done, so a lifecycle-filtered list disagreed
 * with the columns this file drew from it.
 *
 * What stays here is presentation — lane labels and dot colors — which the
 * api has no use for.
 */

export type { TaskLifecycle as Lifecycle };

interface LaneTemplate {
  key: TaskLifecycle;
  label: string;
  dot: string;
}

const LANE_PRESENTATION: Record<TaskLifecycle, Omit<LaneTemplate, "key">> = {
  pending: { label: "Pending", dot: "bg-muted-foreground/50" },
  in_progress: { label: "In progress", dot: "bg-status-running" },
  blocked: { label: "Blocked", dot: "bg-status-blocked" },
  in_review: { label: "In review", dot: "bg-status-review" },
  done: { label: "Done", dot: "bg-status-done" },
  archived: { label: "Archived", dot: "bg-muted-foreground/40" },
};

/**
 * Workflow-order, left-to-right — `TASK_LIFECYCLES` is already in that
 * order. `archived` is last and hidden unless the toggle is on: failed and
 * cancelled tasks are noise on the default board, and an always-visible
 * Cancelled column would dominate it.
 */
const LANES: LaneTemplate[] = TASK_LIFECYCLES.map((key) => ({
  key,
  ...LANE_PRESENTATION[key],
}));
const VISIBLE_LANES = LANES.filter((l) => l.key !== "archived");
const ARCHIVED_LANES = LANES.filter((l) => l.key === "archived");

interface GroupOptions {
  /** Append the Archived lane (failed + cancelled). Default: false. */
  showArchived?: boolean;
}

export function groupTasks(
  tasks: TaskListItem[],
  options: GroupOptions = {},
): BoardLane[] {
  const buckets = Object.fromEntries(
    TASK_LIFECYCLES.map((lane) => [lane, [] as TaskListItem[]]),
  ) as Record<TaskLifecycle, TaskListItem[]>;
  for (const t of tasks) buckets[TASK_LIFECYCLE_OF[t.status]].push(t);
  const template = options.showArchived ? [...VISIBLE_LANES, ...ARCHIVED_LANES] : VISIBLE_LANES;
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
    if (TASK_LIFECYCLE_OF[t.status] === "archived") n += 1;
  }
  return n;
}
