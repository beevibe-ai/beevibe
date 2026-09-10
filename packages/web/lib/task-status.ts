/**
 * Status sets the lifecycle-action UI gates on — "should we show Cancel?"
 * / "should we show Retry?"
 *
 * Both sets are now re-exports from `@beevibe/core/domain/task`, which is
 * also what the api's `/cancel` gate and `TaskService.prepareRetry` read.
 * They used to be declared here as literals, with a comment asking that
 * they be kept "in lockstep" with those two — including a second,
 * byte-identical `TERMINAL_TASK_STATUSES` that shadowed core's own export
 * (whose doc-comment asks callers not to redeclare it). A UI that
 * disagrees with the server about which statuses are terminal offers a
 * Cancel button the api answers with 409.
 *
 * Imported from the `domain/task` subpath, not the package root — the
 * root barrel pulls in `node:crypto` via `./auth` and these are used from
 * client components.
 */

import {
  RETRYABLE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  type TaskStatus,
} from "@beevibe/core/domain/task";

export { RETRYABLE_TASK_STATUSES, TERMINAL_TASK_STATUSES };

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function isRetryableTaskStatus(status: TaskStatus): boolean {
  return RETRYABLE_TASK_STATUSES.includes(status);
}
