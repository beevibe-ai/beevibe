/**
 * Server-side mirror of `packages/web/lib/tasks-grouping.ts`. Keeps the
 * lifecycle → status mapping and the saved-view → status mapping next to
 * the SQL that filters on them, so the web can pass either `lifecycle` or
 * `view` and get the rows it expects.
 */

import type { TaskStatus } from "@beevibe/core";

export type Lifecycle = "pending" | "in_progress" | "in_review" | "done";

export const TASK_STATUSES_BY_LIFECYCLE: Record<Lifecycle, readonly TaskStatus[]> = {
  pending: ["pending", "assigned"],
  in_progress: ["in_progress", "revision", "needs_revision"],
  in_review: ["review", "blocked"],
  done: ["done", "failed", "cancelled"],
};

/**
 * Saved-view shortcut → status set. "all" and "mine" are intentionally
 * absent — "all" means no filter, "mine" routes to `assignee_id`.
 */
export const TASK_STATUSES_BY_VIEW: Partial<Record<string, readonly TaskStatus[]>> = {
  sprint: [
    ...TASK_STATUSES_BY_LIFECYCLE.pending,
    ...TASK_STATUSES_BY_LIFECYCLE.in_progress,
    ...TASK_STATUSES_BY_LIFECYCLE.in_review,
  ],
  timeline: [
    ...TASK_STATUSES_BY_LIFECYCLE.pending,
    ...TASK_STATUSES_BY_LIFECYCLE.in_progress,
    ...TASK_STATUSES_BY_LIFECYCLE.in_review,
    ...TASK_STATUSES_BY_LIFECYCLE.done,
  ],
};
