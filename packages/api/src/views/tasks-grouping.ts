/**
 * Lifecycle / saved-view → status sets for the task-list SQL.
 *
 * The mapping itself now lives in `@beevibe/core/domain/task-lifecycle`,
 * alongside the board lanes the web renders — this file used to be a
 * hand-maintained "server-side mirror" of `packages/web/lib/tasks-grouping.ts`
 * and had drifted from it. The re-exports keep this package's existing
 * import sites and its own naming (`Lifecycle`, `TASK_STATUSES_BY_LIFECYCLE`
 * for the wire-facing four keys) working unchanged.
 */

export {
  TASK_STATUSES_BY_VIEW,
  TASK_STATUSES_BY_WIRE_LIFECYCLE as TASK_STATUSES_BY_LIFECYCLE,
  type TaskWireLifecycle as Lifecycle,
} from "@beevibe/core/domain/task-lifecycle";
