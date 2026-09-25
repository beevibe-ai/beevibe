/**
 * Status sets the lifecycle-action UI gates on — "should we show Cancel?",
 * "should we show Retry?".
 *
 * These used to be declared here: `TERMINAL_TASK_STATUSES` verbatim
 * duplicating the one in `@beevibe/core`'s domain layer, alongside a
 * comment asking that they be kept in lockstep with `api/src/routes/task.ts`
 * `CANCELLABLE_FROM` and `TaskService.prepareRetry`. All four now derive
 * from one map in `@beevibe/core/domain/task-lifecycle`, so there is
 * nothing left to keep in lockstep.
 *
 * Re-exported rather than replaced at the call sites so existing
 * `@/lib/task-status` imports keep working.
 */

export {
  CANCELLABLE_TASK_STATUSES,
  RETRYABLE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  isCancellableTaskStatus,
  isRetryableTaskStatus,
  isTerminalTaskStatus,
} from "@beevibe/core/domain/task-lifecycle";
