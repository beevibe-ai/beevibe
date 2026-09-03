/**
 * Status sets the lifecycle-action UI gates on — "should we show Cancel?"
 * / "should we show Retry?".
 *
 * These now live in `@beevibe/core`'s domain layer and are re-exported
 * here so existing `@/lib/task-status` imports keep working. They used to
 * be a parallel copy of `TERMINAL_TASK_STATUSES` from
 * `core/src/domain/task.ts`, kept in lockstep by comment with that
 * declaration and with `CANCELLABLE_FROM` in `api/src/routes/task.ts`.
 * The api route now derives its cancellable set from the same core
 * constants, so the button the UI shows and the transition the server
 * accepts can no longer disagree.
 */

export {
  CANCELLABLE_TASK_STATUSES,
  RETRYABLE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  isRetryableTaskStatus,
  isTerminalTaskStatus,
} from "@beevibe/core/domain/task";
