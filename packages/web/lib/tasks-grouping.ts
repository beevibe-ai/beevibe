import { TASK_LIFECYCLES, TASK_LIFECYCLE_OF } from "@beevibe/core/domain/task";
import type { TaskListItem } from "@/lib/types/tasks";
import type { BoardLane } from "@/components/tasks/board-column";

/**
 * Board-lane presentation — labels and dot colors — over the lifecycle
 * vocabulary in `@beevibe/core`'s `domain/task.ts`.
 *
 * The lanes and the status → lane mapping used to be declared here and
 * mirrored, four-lanes-deep and already drifted, in
 * `packages/api/src/views/tasks-grouping.ts`. Only the styling below is
 * web-specific, so only the styling lives here now.
 *
 * Imported via `@beevibe/core/domain/task`, NOT the package root: these
 * are runtime *values* in a module the client bundle pulls in, and the
 * root barrel re-exports `./auth`, which reaches for `node:crypto` and
 * fails `next build` with `UnhandledSchemeError`. Same reasoning as
 * `domain/format` — see its header.
 */

export type { TaskLifecycle as Lifecycle } from "@beevibe/core";

type Lane = (typeof TASK_LIFECYCLES)[number];

const LANE_STYLE: Record<Lane, { label: string; dot: string }> = {
  pending: { label: "Pending", dot: "bg-muted-foreground/50" },
  in_progress: { label: "In progress", dot: "bg-status-running" },
  blocked: { label: "Blocked", dot: "bg-status-blocked" },
  in_review: { label: "In review", dot: "bg-status-review" },
  done: { label: "Done", dot: "bg-status-done" },
  archived: { label: "Archived", dot: "bg-muted-foreground/40" },
};

/**
 * Lanes rendered by default. `archived` (failed + cancelled) is appended
 * only when the user flips the archive toggle — `Done` should read as
 * "this shipped".
 */
const VISIBLE_LANES = TASK_LIFECYCLES.filter((l) => l !== "archived");

interface GroupOptions {
  /** Append the Archived lane (failed + cancelled). Default: false. */
  showArchived?: boolean;
}

export function groupTasks(
  tasks: TaskListItem[],
  options: GroupOptions = {},
): BoardLane[] {
  const buckets = Object.fromEntries(
    TASK_LIFECYCLES.map((l) => [l, [] as TaskListItem[]]),
  ) as Record<Lane, TaskListItem[]>;
  for (const t of tasks) buckets[TASK_LIFECYCLE_OF[t.status]].push(t);
  const lanes = options.showArchived ? TASK_LIFECYCLES : VISIBLE_LANES;
  return lanes.map((key) => ({
    key,
    ...LANE_STYLE[key],
    count: buckets[key].length,
    tasks: buckets[key],
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
