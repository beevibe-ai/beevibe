/**
 * Task lifecycle filtering for the views layer.
 *
 * The lifecycle vocabulary itself — the lanes and the status → lane
 * mapping — now lives in `@beevibe/core`'s domain layer, where the web
 * app reads the same declaration. This file used to carry a parallel
 * four-lane copy of `packages/web/lib/tasks-grouping.ts`'s six, and the
 * two had drifted apart while still feeding the same wire parameter; see
 * `TaskLifecycle` in `core/src/domain/task.ts` for what that broke.
 *
 * What stays here is the saved-view → status mapping, which is an api
 * concern (`?view=sprint` has no client-side counterpart).
 */

import {
  CANCELLABLE_TASK_STATUSES,
  TASK_STATUSES,
  type TaskLifecycle,
  type TaskStatus,
} from "@beevibe/core";

export { TASK_STATUSES_BY_LIFECYCLE } from "@beevibe/core";

/** The api's historical name for core's `TaskLifecycle`. */
export type Lifecycle = TaskLifecycle;

/**
 * Saved-view shortcut → status set. "all" and "mine" are intentionally
 * absent — "all" means no filter, "mine" routes to `assignee_id`.
 *
 * Both sets are expressed in terms of the terminal/non-terminal split
 * rather than by listing lanes, which is what they already meant:
 * "sprint" is the work still in flight, "timeline" is everything that
 * has a timeline to plot.
 */
export const TASK_STATUSES_BY_VIEW: Partial<Record<string, readonly TaskStatus[]>> = {
  sprint: CANCELLABLE_TASK_STATUSES,
  timeline: TASK_STATUSES,
};
