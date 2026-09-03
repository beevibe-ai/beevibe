/**
 * Saved-view → status mappings, kept next to the SQL that filters on them.
 *
 * The lifecycle taxonomy this builds on (`TaskLifecycle`,
 * `TASK_STATUSES_BY_LIFECYCLE`) lives in `@beevibe/core`, which the web
 * task board reads too. This module used to declare its own copy of it,
 * and the two had drifted: the server folded `blocked` into `in_review`
 * and `failed` / `cancelled` into `done`, and the lanes the board added
 * since (`blocked`, `archived`) were missing entirely — so
 * `?lifecycle=blocked` failed the route's key check and fell through to
 * *no* status filter, silently returning every task instead of the
 * blocked ones.
 */

import { TASK_STATUSES_BY_LIFECYCLE, type TaskStatus } from "@beevibe/core";

/**
 * Saved-view shortcut → status set. "all" and "mine" are intentionally
 * absent — "all" means no filter, "mine" routes to `assignee_id`.
 *
 * Both sets are spelled out over the lanes they cover so their membership
 * is unchanged by the lane split described above: `sprint` is everything
 * still in flight, `timeline` is every status there is.
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
