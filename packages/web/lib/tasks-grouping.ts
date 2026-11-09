import { TASK_LIFECYCLE_OF, TASK_LIFECYCLES, type TaskLifecycle } from "@beevibe/core";
import type { TaskListItem } from "@/lib/types/tasks";
import type { BoardLane } from "@/components/tasks/board-column";

/**
 * Which lane a task belongs in is a wire contract with the api — the
 * board draws one column per lane and `GET /task?lifecycle=` filters by
 * the same names — so the status → lane table lives in
 * `@beevibe/core/domain/task.ts` and is imported here. This module owns
 * only the presentation half: each lane's label and dot color, and the
 * bucketing that turns a flat task list into board columns.
 */
export type Lifecycle = TaskLifecycle;

interface LaneTemplate {
  key: Lifecycle;
  label: string;
  dot: string;
}

const LANE_PRESENTATION: Record<Lifecycle, Omit<LaneTemplate, "key">> = {
  pending: { label: "Pending", dot: "bg-muted-foreground/50" },
  in_progress: { label: "In progress", dot: "bg-status-running" },
  blocked: { label: "Blocked", dot: "bg-status-blocked" },
  in_review: { label: "In review", dot: "bg-status-review" },
  done: { label: "Done", dot: "bg-status-done" },
  archived: { label: "Archived", dot: "bg-muted-foreground/40" },
};

/**
 * The lane the archive toggle hides. `failed` and `cancelled` are
 * terminal states that aren't success, so `Done` can read as "this
 * shipped" and the toggle exposes what didn't.
 */
const ARCHIVED_LANE: Lifecycle = "archived";

// Workflow order comes from core's TASK_LIFECYCLES.
const VISIBLE_LANES: LaneTemplate[] = TASK_LIFECYCLES.filter(
  (key) => key !== ARCHIVED_LANE,
).map((key) => ({ key, ...LANE_PRESENTATION[key] }));

const ARCHIVED_TEMPLATE: LaneTemplate = {
  key: ARCHIVED_LANE,
  ...LANE_PRESENTATION[ARCHIVED_LANE],
};

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
  ) as Record<Lifecycle, TaskListItem[]>;
  for (const t of tasks) buckets[TASK_LIFECYCLE_OF[t.status]].push(t);
  const template = options.showArchived
    ? [...VISIBLE_LANES, ARCHIVED_TEMPLATE]
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
    if (TASK_LIFECYCLE_OF[t.status] === ARCHIVED_LANE) n += 1;
  }
  return n;
}
