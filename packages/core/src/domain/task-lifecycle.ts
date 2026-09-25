/**
 * The task status vocabulary shared by the api's view layer and the web app:
 * which lane a status belongs to on the board, and which statuses the
 * lifecycle actions (Cancel / Retry) are legal from.
 *
 * This existed as three partial copies that were kept in sync by comment:
 *
 *   - `packages/web/lib/tasks-grouping.ts` — the board's six lanes and the
 *     status → lane map the UI actually renders.
 *   - `packages/api/src/views/tasks-grouping.ts` — described in its own
 *     header as a "server-side mirror" of the web file, backing the
 *     `GET /task?lifecycle=` filter. It had **drifted**: it knew only four
 *     lanes, folding `blocked` into `in_review` and `failed`/`cancelled`
 *     into `done`. So `?lifecycle=blocked` and `?lifecycle=archived` — both
 *     of which the web's `TaskListFilter` types as valid — were silently
 *     dropped by the route's allow-list and returned every task unfiltered,
 *     while `?lifecycle=done` returned tasks the board files under Archived.
 *   - `packages/web/lib/task-status.ts` — a verbatim second declaration of
 *     `TERMINAL_TASK_STATUSES` (already in `./task.js`) plus the retry set,
 *     carrying a comment listing the three other places to keep it in
 *     lockstep with.
 *
 * That is the same drift-by-comment shape `./format.ts` was extracted to
 * kill, with the same consequence: two sides of one wire contract
 * disagreeing about what a lane means.
 *
 * Everything here is pure and dependency-free — safe to pull into the
 * browser bundle, which is why it lives in `domain/` next to `format.ts`.
 *
 * IMPORT THIS VIA `@beevibe/core/domain/task-lifecycle`, NOT the package
 * root. The root barrel re-exports `./auth`, which reaches for
 * `node:crypto`; a *value* import of the root from a client component
 * drags that into webpack and fails `next build`. (`./task.js`, which this
 * module imports for `TASK_STATUSES`, is itself pure — its only import is
 * type-only and erased.)
 */

import { TASK_STATUSES, type TaskStatus } from "./task.js";

/**
 * Task statuses that signal "this task has run its course" — done /
 * failed / cancelled. Distinct from the narrower TERMINAL set used by
 * task-service for status-patch guards (which excludes 'failed' so
 * retries can move out of it). Watch_tasks fires on transitions into
 * this set.
 *
 * Declared here rather than in `./task.js` so a browser bundle can reach
 * it through this module's subpath without importing the package root
 * (whose barrel pulls in `./auth` → `node:crypto`). `packages/web` had
 * grown a verbatim second copy for exactly that reason.
 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "done",
  "failed",
  "cancelled",
] as const;

/**
 * A board lane. Six of them, in workflow order left-to-right.
 *
 * `blocked` is its own lane rather than part of `in_review`: blocked means
 * waiting on an external dependency, `review` means waiting on a human
 * verdict. Different action by whoever is reading the board, so a different
 * column.
 *
 * `archived` collects `failed` and `cancelled` — terminal but not success.
 * Keeping them out of `done` is what lets `Done` read as "this shipped".
 */
export type TaskLifecycle =
  | "pending"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "archived";

/** The lanes in workflow order. `archived` is last and hidden by default. */
export const TASK_LIFECYCLES: readonly TaskLifecycle[] = [
  "pending",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "archived",
] as const;

/**
 * Status → lane. Total over `TaskStatus`, so adding a status to the union
 * is a compile error here until it is given a lane — which is the point of
 * having one map instead of three.
 */
export const TASK_LIFECYCLE_OF: Record<TaskStatus, TaskLifecycle> = {
  pending: "pending",
  assigned: "pending",
  in_progress: "in_progress",
  needs_revision: "in_progress",
  revision: "in_progress",
  review: "in_review",
  blocked: "blocked",
  done: "done",
  failed: "archived",
  cancelled: "archived",
};

/**
 * The statuses in one or more lanes, in `TASK_STATUSES` order.
 *
 * Callers that need a status set for a SQL `= ANY($1)` filter build it from
 * lanes rather than enumerating statuses, so the set can't fall behind the
 * map above.
 */
export function taskStatusesInLifecycles(
  ...lifecycles: readonly TaskLifecycle[]
): readonly TaskStatus[] {
  const wanted = new Set<TaskLifecycle>(lifecycles);
  return TASK_STATUSES.filter((s) => wanted.has(TASK_LIFECYCLE_OF[s]));
}

/** The inverse of {@link TASK_LIFECYCLE_OF}: lane → its statuses. */
export const TASK_STATUSES_BY_LIFECYCLE: Record<TaskLifecycle, readonly TaskStatus[]> =
  Object.fromEntries(
    TASK_LIFECYCLES.map((l) => [l, taskStatusesInLifecycles(l)]),
  ) as Record<TaskLifecycle, readonly TaskStatus[]>;

/**
 * Statuses `POST /task/:id/retry` accepts, and the ones the UI shows a
 * Retry button from. `done` is excluded — success isn't a retry candidate.
 *
 * Mirrors the guard in `TaskService.prepareRetry`, which raises on anything
 * outside this set.
 */
export const RETRYABLE_TASK_STATUSES: readonly TaskStatus[] = ["failed", "cancelled"] as const;

/**
 * Statuses `POST /task/:id/cancel` accepts: the complement of
 * {@link TERMINAL_TASK_STATUSES}. Derived rather than enumerated — the
 * api's route had spelled all seven out by hand, which is a list to forget
 * to update the next time a status is added.
 */
export const CANCELLABLE_TASK_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter(
  (s) => !TERMINAL_TASK_STATUSES.includes(s),
);

/** `done` / `failed` / `cancelled` — this task has run its course. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function isRetryableTaskStatus(status: TaskStatus): boolean {
  return RETRYABLE_TASK_STATUSES.includes(status);
}

export function isCancellableTaskStatus(status: TaskStatus): boolean {
  return CANCELLABLE_TASK_STATUSES.includes(status);
}
