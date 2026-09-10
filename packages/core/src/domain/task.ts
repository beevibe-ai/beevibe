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
 * Workflow lane a task's status belongs to — the coarse grouping the
 * board renders as columns and `GET /task?lifecycle=` filters on.
 *
 * This used to be declared twice, and the two had drifted:
 * `packages/api/src/views/tasks-grouping.ts` had four lanes (folding
 * `blocked` into `in_review` and `failed`/`cancelled` into `done`) while
 * `packages/web/lib/tasks-grouping.ts` had these six. Both fed the same
 * wire parameter — the web client typed `TaskListFilter.lifecycle` with
 * its own six-value union while the api validated against its own four —
 * so `?lifecycle=blocked` typechecked on the client, failed the server's
 * allow-list, and silently returned *unfiltered* tasks. The six-lane
 * shape below is the one the UI actually renders, so it wins.
 *
 * Lane semantics:
 * - `blocked` is its own lane, not part of `in_review`: blocked means
 *   waiting on an external dependency, which asks a different action of
 *   the human than waiting on their verdict does.
 * - `archived` holds the terminal-but-not-successful statuses (`failed`,
 *   `cancelled`), so `done` reads as "this shipped."
 */
export type TaskLifecycle =
  | "pending"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "archived";

/** Workflow order, left-to-right — the order the board lays lanes out. */
export const TASK_LIFECYCLES: readonly TaskLifecycle[] = [
  "pending",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "archived",
] as const;

/**
 * Status → lane. The single source of truth for the grouping: everything
 * below is derived from it, so adding a `TaskStatus` is a compile error
 * here (exhaustive `Record`) and needs no other edit.
 */
export const TASK_LIFECYCLE_OF_STATUS: Record<TaskStatus, TaskLifecycle> = {
  pending: "pending",
  assigned: "pending",
  in_progress: "in_progress",
  needs_revision: "in_progress",
  revision: "in_progress",
  review: "in_review",
  blocked: "blocked",
  done: "done",
  failed: "archived",
  cancelled: "archived",
};

function groupStatusesByLifecycle(): Record<TaskLifecycle, readonly TaskStatus[]> {
  const buckets = Object.fromEntries(
    TASK_LIFECYCLES.map((lifecycle) => [lifecycle, [] as TaskStatus[]]),
  ) as Record<TaskLifecycle, TaskStatus[]>;
  for (const status of TASK_STATUSES) {
    buckets[TASK_LIFECYCLE_OF_STATUS[status]].push(status);
  }
  return buckets;
}

/**
 * Lane → the statuses in it, inverted from {@link TASK_LIFECYCLE_OF_STATUS}
 * rather than hand-listed so the two can't disagree. Statuses appear in
 * `TASK_STATUSES` order.
 */
export const TASK_STATUSES_BY_LIFECYCLE: Record<TaskLifecycle, readonly TaskStatus[]> =
  groupStatusesByLifecycle();

/**
 * Statuses `/task/:id/retry` accepts — the `archived` lane, i.e. terminal
 * but unsuccessful. Kept in step with `TaskService.prepareRetry`, which
 * gates on this set.
 */
export const RETRYABLE_TASK_STATUSES: readonly TaskStatus[] =
  TASK_STATUSES_BY_LIFECYCLE.archived;

/**
 * Statuses `/task/:id/cancel` accepts — the exact complement of
 * {@link TERMINAL_TASK_STATUSES}. Derived rather than listed: the api
 * spelled all seven out by hand, which meant a new non-terminal status
 * would have been silently un-cancellable.
 */
export const CANCELLABLE_TASK_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter(
  (status) => !TERMINAL_TASK_STATUSES.includes(status),
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
