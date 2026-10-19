/**
 * Task status → lifecycle grouping, for both the board the web renders
 * and the `?lifecycle=` filter the api accepts.
 *
 * These were two modules named `tasks-grouping.ts` — one in
 * `packages/web/lib/`, one in `packages/api/src/views/` — and the api's
 * opened by calling itself a "Server-side mirror" of the web's. It had
 * stopped being one. The web grew a `blocked` lane (a blocker is waiting
 * on a dependency, not on a human verdict, so it reads as its own column)
 * and an `archived` lane (`failed` / `cancelled` kept out of Done, which
 * should mean "this shipped"); the server still folded `blocked` into
 * `in_review` and `failed` / `cancelled` into `done`, and both files
 * exported a type called `Lifecycle` for their own, different unions.
 *
 * The web's `TaskListFilter.lifecycle` was typed with the six-lane union
 * while the route validates against the server's four keys, so
 * `lifecycle: "blocked"` and `lifecycle: "archived"` typechecked on the
 * client and were dropped by the api as unknown values.
 *
 * Both vocabularies are wanted — the board needs the fine-grained lanes,
 * the wire contract is the four coarse keys clients already send. What
 * was wrong is that the relationship between them lived in a comment. So
 * there is one status → lane map here, the coarse buckets are declared as
 * a grouping *of lanes* ({@link WIRE_LIFECYCLE_LANES}) and the status sets
 * the SQL filters on are derived from the two. A new `TaskStatus` fails to
 * compile until it is given a lane, and it then lands in exactly one wire
 * bucket automatically.
 *
 * Pure and dependency-free, like `./format.ts`, so the web can import it
 * directly. IMPORT VIA `@beevibe/core/domain/task-lifecycle`, NOT the
 * package root or the `domain` barrel — both re-export modules that reach
 * for `node:crypto`, which breaks `next build` on a value import from a
 * client component.
 */

import type { TaskStatus } from "./task.js";

/**
 * Board lanes, workflow order. The web renders one column per lane
 * (`archived` only when the user asks for it); the api coarsens these
 * into {@link TaskWireLifecycle} for its query filter.
 */
export type TaskLifecycle =
  | "pending"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "archived";

/**
 * Status → lane. The one source of truth for the grouping; everything
 * else in this module is derived from it.
 *
 * - `blocked` is its own lane rather than part of In review: blocked
 *   means waiting on an external dependency, which asks something
 *   different of the human reading the board than "waiting on a verdict".
 * - `failed` and `cancelled` are terminal-but-not-success, so they go to
 *   `archived` (hidden by default) and leave Done meaning "this shipped".
 *
 * Insertion order matters: {@link TASK_STATUSES_BY_WIRE_LIFECYCLE} reads
 * it to build its status arrays, and tests assert on those arrays.
 */
export const TASK_LIFECYCLE_OF: Record<TaskStatus, TaskLifecycle> = {
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

/**
 * The lifecycle values the api's `?lifecycle=` filter accepts — the
 * coarse, four-key vocabulary already in the wire contract. Narrower than
 * {@link TaskLifecycle} on purpose: clients filter by "roughly where in
 * the flow", the board draws the finer distinction locally.
 */
export type TaskWireLifecycle = "pending" | "in_progress" | "in_review" | "done";

/**
 * How the wire's four keys coarsen the board's six lanes. This is the
 * whole of the difference between the two vocabularies, which is why it
 * is spelled out here rather than implied by two hand-written tables:
 * asking for `in_review` gets blocked tasks too, and `done` includes what
 * the board files under Archived.
 */
export const WIRE_LIFECYCLE_LANES: Record<TaskWireLifecycle, readonly TaskLifecycle[]> = {
  pending: ["pending"],
  in_progress: ["in_progress"],
  in_review: ["in_review", "blocked"],
  done: ["done", "archived"],
};

function statusesInLanes(lanes: readonly TaskLifecycle[]): readonly TaskStatus[] {
  const entries = Object.entries(TASK_LIFECYCLE_OF) as Array<[TaskStatus, TaskLifecycle]>;
  return entries.filter(([, lane]) => lanes.includes(lane)).map(([status]) => status);
}

/** Wire lifecycle → the statuses the task-list SQL filters on. */
export const TASK_STATUSES_BY_WIRE_LIFECYCLE: Record<TaskWireLifecycle, readonly TaskStatus[]> = {
  pending: statusesInLanes(WIRE_LIFECYCLE_LANES.pending),
  in_progress: statusesInLanes(WIRE_LIFECYCLE_LANES.in_progress),
  in_review: statusesInLanes(WIRE_LIFECYCLE_LANES.in_review),
  done: statusesInLanes(WIRE_LIFECYCLE_LANES.done),
};

/**
 * Saved-view shortcut → status set. "all" and "mine" are intentionally
 * absent — "all" means no filter, "mine" routes to `assignee_id`.
 */
export const TASK_STATUSES_BY_VIEW: Partial<Record<string, readonly TaskStatus[]>> = {
  sprint: [
    ...TASK_STATUSES_BY_WIRE_LIFECYCLE.pending,
    ...TASK_STATUSES_BY_WIRE_LIFECYCLE.in_progress,
    ...TASK_STATUSES_BY_WIRE_LIFECYCLE.in_review,
  ],
  timeline: [
    ...TASK_STATUSES_BY_WIRE_LIFECYCLE.pending,
    ...TASK_STATUSES_BY_WIRE_LIFECYCLE.in_progress,
    ...TASK_STATUSES_BY_WIRE_LIFECYCLE.in_review,
    ...TASK_STATUSES_BY_WIRE_LIFECYCLE.done,
  ],
};
