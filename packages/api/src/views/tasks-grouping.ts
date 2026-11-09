/**
 * The api's saved-view → status mapping, next to the SQL that filters on
 * it.
 *
 * The lifecycle → status mapping this file used to carry has moved to
 * `@beevibe/core`'s domain layer, where the web board reads the same
 * table. This file had described itself as a "server-side mirror" of
 * `packages/web/lib/tasks-grouping.ts` and kept a hand-written copy in
 * sync by comment; the copy had drifted (`blocked` folded into
 * `in_review`, `failed`/`cancelled` into `done`), so a `?lifecycle=`
 * filter returned rows the lane it was named after doesn't hold. The
 * re-exports below keep this package's existing import sites working.
 */

import { taskStatusesForLifecycles, type TaskStatus } from "@beevibe/core";

export {
  TASK_LIFECYCLES,
  TASK_STATUSES_BY_LIFECYCLE,
  type TaskLifecycle as Lifecycle,
} from "@beevibe/core";

/**
 * Saved-view shortcut → status set. "all" and "mine" are intentionally
 * absent — "all" means no filter, "mine" routes to `assignee_id`.
 *
 * Spelled as lane lists rather than status lists so they track the
 * lifecycle table. `sprint` names `blocked` explicitly because it was
 * previously included via the api's old `in_review` lane, and `timeline`
 * names `archived` because it came in via the old `done` lane — both
 * sets are unchanged from before the split.
 */
export const TASK_STATUSES_BY_VIEW: Partial<Record<string, readonly TaskStatus[]>> = {
  sprint: taskStatusesForLifecycles(["pending", "in_progress", "blocked", "in_review"]),
  timeline: taskStatusesForLifecycles([
    "pending",
    "in_progress",
    "blocked",
    "in_review",
    "done",
    "archived",
  ]),
};
