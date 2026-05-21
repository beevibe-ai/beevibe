import type { TaskStatus } from "@beevibe/core";

/**
 * Status sets the lifecycle-action UI gates on. Single source of truth
 * for "should we show Cancel?" / "should we show Retry?" — keep these
 * in lockstep with:
 *   - api/src/routes/task.ts `CANCELLABLE_FROM` (terminal complement)
 *   - core/src/services/task-service.ts `prepareRetry` (failed | cancelled)
 *
 * Typed as `readonly TaskStatus[]` so `.includes(task.status)` typechecks
 * without a cast.
 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "done",
  "failed",
  "cancelled",
];

export const RETRYABLE_TASK_STATUSES: readonly TaskStatus[] = [
  "failed",
  "cancelled",
];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function isRetryableTaskStatus(status: TaskStatus): boolean {
  return RETRYABLE_TASK_STATUSES.includes(status);
}
