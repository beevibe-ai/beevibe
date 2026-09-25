/**
 * Status sets backing the `GET /task?lifecycle=` and `?view=` filters.
 *
 * This file used to declare its own lifecycle → status map, described in
 * its header as a "server-side mirror" of `packages/web/lib/tasks-grouping.ts`.
 * The mirror had drifted: it knew four lanes where the board renders six,
 * folding `blocked` into `in_review` and `failed`/`cancelled` into `done`.
 * The web's `TaskListFilter` meanwhile types `lifecycle` as the board's
 * six-lane union, so `?lifecycle=blocked` and `?lifecycle=archived`
 * type-checked on the client but fell out of this module's key set — the
 * route's allow-list dropped them and answered with every task, unfiltered.
 *
 * The map now lives in `@beevibe/core/domain/task-lifecycle`, which both
 * sides read. All six lanes are filterable, and `in_review` / `done` mean
 * on the wire what they mean on the board.
 */

import { taskStatusesInLifecycles } from "@beevibe/core/domain/task-lifecycle";
import type { TaskStatus } from "@beevibe/core";

export {
  TASK_STATUSES_BY_LIFECYCLE,
  type TaskLifecycle as Lifecycle,
} from "@beevibe/core/domain/task-lifecycle";

/**
 * Saved-view shortcut → status set. "all" and "mine" are intentionally
 * absent — "all" means no filter, "mine" routes to `assignee_id`.
 *
 * Both sets name `blocked` and `archived` explicitly. They were already
 * included before this module started deriving from the canonical map —
 * `sprint` got `blocked` via the old four-lane `in_review`, and `timeline`
 * got `failed`/`cancelled` via the old `done` — so spelling the lanes out
 * keeps each view's status set byte-for-byte what it was, with the
 * folding now visible instead of implied.
 */
export const TASK_STATUSES_BY_VIEW: Partial<Record<string, readonly TaskStatus[]>> = {
  sprint: taskStatusesInLifecycles("pending", "in_progress", "blocked", "in_review"),
  timeline: taskStatusesInLifecycles(
    "pending",
    "in_progress",
    "blocked",
    "in_review",
    "done",
    "archived",
  ),
};
