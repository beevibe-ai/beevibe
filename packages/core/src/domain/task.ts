import type { ResolutionProposal } from "./escalation.js";

export type TaskStatus =
  | "pending"
  | "assigned"
  | "in_progress"
  | "needs_revision"
  | "revision"
  | "review"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "assigned",
  "in_progress",
  "needs_revision",
  "revision",
  "review",
  "blocked",
  "done",
  "failed",
  "cancelled",
] as const;

/**
 * Task statuses that signal "this task has run its course" — done /
 * failed / cancelled. Distinct from the narrower TERMINAL set used by
 * task-service for status-patch guards (which excludes 'failed' so
 * retries can move out of it). Watch_tasks fires on transitions into
 * this set; downstream services that need the same "no further work
 * expected" semantics should import from here rather than redeclaring.
 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  "done",
  "failed",
  "cancelled",
] as const;

/**
 * The board lane a task's status belongs to.
 *
 * This vocabulary existed twice — `packages/web/lib/tasks-grouping.ts`
 * (six lanes, drives the kanban board) and
 * `packages/api/src/views/tasks-grouping.ts` (four lanes, filters the
 * `GET /task` SQL), the latter labelled "server-side mirror" of the
 * former. The two had already drifted: the api folded `blocked` into
 * `in_review` and `failed`/`cancelled` into `done`, so the six lanes the
 * user sees on the board were not the lanes the api could filter by.
 * `TaskListFilter.lifecycle` on the web is typed from the six-lane union,
 * and `GET /task` silently drops any value it doesn't recognize — so
 * `?lifecycle=blocked` returned every task rather than the blocked ones.
 *
 * One declaration, here, because it is one concept: the api filters on
 * the same lanes the board renders.
 */
export type TaskLifecycle =
  | "pending"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "archived";

/**
 * Workflow order, left-to-right — the order the board renders lanes in,
 * and the order {@link TASK_STATUSES_BY_LIFECYCLE} is keyed in. `blocked`
 * sits between `in_progress` and `in_review` because that is where
 * blockers arise: work started, hit an impasse, needs unblocking before
 * it can land in review.
 */
export const TASK_LIFECYCLES: readonly TaskLifecycle[] = [
  "pending",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "archived",
] as const;

/**
 * Status → lane. Exhaustive over {@link TaskStatus} by its `Record` type,
 * so a new status is a compile error here rather than a task that
 * silently vanishes from the board.
 *
 * - `blocked` gets its own lane rather than folding into `in_review`:
 *   blocked means waiting on an external dependency, which asks something
 *   different of the human reading the board than "waiting on a verdict".
 * - `failed` and `cancelled` are terminal-but-not-success, so they go to
 *   `archived` (hidden behind a toggle) — `done` should read as "this
 *   shipped".
 */
export const TASK_LIFECYCLE_OF: Record<TaskStatus, TaskLifecycle> = {
  pending: "pending",
  assigned: "pending",
  in_progress: "in_progress",
  revision: "in_progress",
  needs_revision: "in_progress",
  review: "in_review",
  blocked: "blocked",
  done: "done",
  failed: "archived",
  cancelled: "archived",
};

/**
 * {@link TASK_LIFECYCLE_OF} inverted — the statuses in each lane, for the
 * `WHERE status = ANY($1)` side of the api's task list. Derived rather
 * than written out so the two directions cannot disagree.
 */
export const TASK_STATUSES_BY_LIFECYCLE: Record<TaskLifecycle, readonly TaskStatus[]> =
  TASK_LIFECYCLES.reduce(
    (acc, lifecycle) => {
      acc[lifecycle] = TASK_STATUSES.filter(
        (status) => TASK_LIFECYCLE_OF[status] === lifecycle,
      );
      return acc;
    },
    {} as Record<TaskLifecycle, TaskStatus[]>,
  );

export type TaskPriority = "low" | "medium" | "high" | "critical";

export const TASK_PRIORITIES: readonly TaskPriority[] = ["low", "medium", "high", "critical"] as const;

export type CreatorType = "person" | "agent";

/**
 * Explicit context for the next executor dispatch of this task. Set by
 * `reviseTask` (revision feedback) and `EscalationService.resolve`
 * (post-escalation resolution). Read by dispatch.ts (M6.5) to derive the
 * `ResumeReason` and pin `priorSessionId`. JSONB column; structurally
 * matches the typed union below.
 *
 * Discriminated by `kind`. Both kinds carry `prior_session_id` so dispatch
 * doesn't need to call `findLatestForTask` for synthetic tasks (B-side
 * post-escalation tasks have no own prior session via that path).
 */
export interface RevisionContext {
  kind: "revision";
  feedback: string;
  source: "human" | "parent_agent";
  from_status: "review" | "needs_revision" | "blocked";
  reviser_agent_id?: string;
  prior_session_id?: string;
}

export interface PostEscalationContext {
  kind: "post_escalation";
  role: "initiator" | "counterparty";
  /** Stored as JSONB, so this is the serialized form of the same shape. */
  resolution: ResolutionProposal;
  notes?: string;
  prior_session_id?: string;
}

export type NextDispatchContext = RevisionContext | PostEscalationContext;

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_id?: string;
  creator_id: string;
  creator_type: CreatorType;
  parent_task_id?: string;
  result_summary?: string;
  blocker_agent_id?: string;
  blocker_reason?: string;
  repo_url?: string;
  next_dispatch_context?: NextDispatchContext;
  created_at: Date;
  updated_at: Date;
}
