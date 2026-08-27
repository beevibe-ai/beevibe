/**
 * Task lifecycle lanes — the coarse grouping the tasks board renders as
 * columns and the api's `GET /task?lifecycle=` filters on.
 *
 * This mapping used to exist twice: `packages/web/lib/tasks-grouping.ts`
 * held the status → lane direction for the board, and
 * `packages/api/src/views/tasks-grouping.ts` held the lane → statuses
 * direction for the SQL, each a hand-kept mirror of the other. They
 * drifted — the web split `blocked` into its own lane and moved
 * `failed`/`cancelled` into `archived`, while the api still folded
 * `blocked` into `in_review` and `failed`/`cancelled` into `done`. So
 * `?lifecycle=done` returned rows the Done column would never show.
 *
 * One map here, both directions derived from it, so the lanes the board
 * draws and the statuses the server filters on cannot disagree again.
 */

import { TASK_STATUSES, type TaskStatus } from "./task.js";

export type TaskLifecycle =
  | "pending"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "archived";

/**
 * Workflow order, left-to-right — the order the board draws its columns.
 * `blocked` sits between in-progress and in-review because that's where
 * blockers actually arise: work started, hit an impasse, needs unblocking
 * before it can land in review.
 */
export const TASK_LIFECYCLES: readonly TaskLifecycle[] = [
  "pending",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "archived",
] as const;

/**
 * Status → lane.
 *
 * - `blocked` is its own lane rather than part of In review. Blocked means
 *   waiting on an external dependency; In review means waiting on a human
 *   verdict. Different action by the human reading the board, so a
 *   different column.
 * - `failed` and `cancelled` are terminal but not success, so they land in
 *   `archived` (hidden behind a toggle on the board) rather than `done` —
 *   Done should read as "this shipped."
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

/** Lane → the statuses in it. The inverse of {@link TASK_LIFECYCLE_OF}. */
export const TASK_STATUSES_BY_LIFECYCLE: Record<TaskLifecycle, readonly TaskStatus[]> =
  buildStatusesByLifecycle();

function buildStatusesByLifecycle(): Record<TaskLifecycle, readonly TaskStatus[]> {
  const out = Object.fromEntries(
    TASK_LIFECYCLES.map((lane) => [lane, [] as TaskStatus[]]),
  ) as Record<TaskLifecycle, TaskStatus[]>;
  // Iterate TASK_STATUSES rather than the map's own keys so each lane's
  // statuses come out in canonical status order regardless of how
  // TASK_LIFECYCLE_OF is written.
  for (const status of TASK_STATUSES) out[TASK_LIFECYCLE_OF[status]].push(status);
  return out;
}

/**
 * Saved-view shortcut → status set, for `GET /task?view=`. "all" and
 * "mine" are intentionally absent — "all" means no filter, "mine" routes
 * to `assignee_id`.
 *
 * Composed from the lanes so a new `TaskStatus` joins the right views by
 * virtue of the lane it maps to. `sprint` is everything still in flight;
 * `timeline` adds the shipped work but still omits `archived`.
 */
export const TASK_STATUSES_BY_VIEW: Partial<Record<string, readonly TaskStatus[]>> = {
  sprint: lanesToStatuses(["pending", "in_progress", "blocked", "in_review"]),
  timeline: lanesToStatuses(["pending", "in_progress", "blocked", "in_review", "done"]),
};

function lanesToStatuses(lanes: readonly TaskLifecycle[]): readonly TaskStatus[] {
  return lanes.flatMap((lane) => TASK_STATUSES_BY_LIFECYCLE[lane]);
}

const LIFECYCLE_SET = new Set<string>(TASK_LIFECYCLES);

/** Narrow an untrusted query-string value to a lane. */
export function isTaskLifecycle(value: string): value is TaskLifecycle {
  return LIFECYCLE_SET.has(value);
}
