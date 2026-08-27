/**
 * Status sets the lifecycle-action UI gates on — "should we show Cancel?"
 * / "should we show Retry?".
 *
 * These used to be a hand-kept parallel copy of the same lists in
 * `@beevibe/core`'s domain layer, with a comment asking the next editor to
 * keep them in lockstep with `api/src/routes/task.ts` and
 * `core/src/services/task-service.ts`. They're re-exported from core now,
 * so the button the UI shows and the transition the api will actually
 * accept can't disagree. The re-export keeps existing
 * `@/lib/task-status` imports working.
 *
 * It goes through the `domain/task` subpath, not the package root: these
 * are runtime values reached from a client component, and a value import
 * of the root drags `auth`'s `node:crypto` / `node:util` into webpack and
 * fails `next build`. See `domain/format.ts` for the long version.
 */

export {
  RETRYABLE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  isRetryableTaskStatus,
  isTerminalTaskStatus,
} from "@beevibe/core/domain/task";
