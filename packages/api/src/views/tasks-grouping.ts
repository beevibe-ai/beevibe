/**
 * Saved-view shortcuts for `GET /task`.
 *
 * The lifecycle vocabulary itself — the six lanes and the status → lane
 * mapping — lives in `@beevibe/core`'s `domain/task.ts`, where the web's
 * kanban board reads the same declaration. This file used to carry a
 * "server-side mirror" of it that had drifted to four lanes; see the
 * `TaskLifecycle` doc comment for what that cost.
 */

import type { TaskStatus } from "@beevibe/core";
import { TASK_STATUSES_BY_LIFECYCLE } from "@beevibe/core";

export type { TaskLifecycle as Lifecycle } from "@beevibe/core";
export { TASK_LIFECYCLES, TASK_STATUSES_BY_LIFECYCLE } from "@beevibe/core";

/**
 * Saved-view shortcut → status set. "all" and "mine" are intentionally
 * absent — "all" means no filter, "mine" routes to `assignee_id`.
 *
 * Spelled out lane-by-lane rather than as a lifecycle range so the status
 * sets stay exactly what they were before `blocked` and `archived` became
 * lanes of their own: `sprint` is everything not yet finished, `timeline`
 * is everything.
 */
export const TASK_STATUSES_BY_VIEW: Partial<Record<string, readonly TaskStatus[]>> = {
  sprint: [
    ...TASK_STATUSES_BY_LIFECYCLE.pending,
    ...TASK_STATUSES_BY_LIFECYCLE.in_progress,
    ...TASK_STATUSES_BY_LIFECYCLE.blocked,
    ...TASK_STATUSES_BY_LIFECYCLE.in_review,
  ],
  timeline: [
    ...TASK_STATUSES_BY_LIFECYCLE.pending,
    ...TASK_STATUSES_BY_LIFECYCLE.in_progress,
    ...TASK_STATUSES_BY_LIFECYCLE.blocked,
    ...TASK_STATUSES_BY_LIFECYCLE.in_review,
    ...TASK_STATUSES_BY_LIFECYCLE.done,
    ...TASK_STATUSES_BY_LIFECYCLE.archived,
  ],
};
