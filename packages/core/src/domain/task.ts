/**
 * Task domain types and the status / lifecycle taxonomy.
 *
 * The constants here are pure and dependency-free, so they are safe to
 * pull into the browser bundle — the web task board groups on the same
 * lifecycle map the api filters SQL on.
 *
 * IMPORT THE VALUES VIA `@beevibe/core/domain/task`, NOT the package
 * root. The root barrel re-exports `./auth`, which reaches for
 * `node:crypto` and `node:util`; a *value* import of the root from a
 * client component drags those into webpack and fails `next build` with
 * `UnhandledSchemeError: Reading from "node:crypto" is not handled by
 * plugins`. Type-only root imports are fine — they erase — which is why
 * `import type { TaskStatus } from "@beevibe/core"` is everywhere in the
 * web app. Same rule and same reason as `./format.ts`; see its header.
 */

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
 * Statuses a failed run can be retried out of. The complement pair to
 * `CANCELLABLE_TASK_STATUSES` below: a task is either still cancellable
 * (work in flight) or already terminal, and a terminal task is retryable
 * only when it didn't succeed.
 */
export const RETRYABLE_TASK_STATUSES: readonly TaskStatus[] = [
  "failed",
  "cancelled",
] as const;

/**
 * Statuses `POST /task/:id/cancel` accepts — every non-terminal status.
 * Derived from {@link TERMINAL_TASK_STATUSES} rather than listed, so
 * adding a `TaskStatus` can't leave the two sets disagreeing about
 * whether a new status is cancellable.
 */
export const CANCELLABLE_TASK_STATUSES: readonly TaskStatus[] = TASK_STATUSES.filter(
  (s) => !TERMINAL_TASK_STATUSES.includes(s),
);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function isRetryableTaskStatus(status: TaskStatus): boolean {
  return RETRYABLE_TASK_STATUSES.includes(status);
}

/**
 * Board lane a task belongs to — the coarse grouping both the web task
 * board and the server-side `?lifecycle=` filter speak in.
 *
 * Ten statuses collapse into six lanes. `blocked` and `archived` are
 * deliberately their own lanes:
 *
 * - `blocked` = waiting on an external dependency, which asks something
 *   different of the human reading the board than `in_review` (waiting on
 *   a human verdict), so it gets its own column.
 * - `archived` = `failed` / `cancelled`. Terminal but not success, so
 *   they stay out of `done` — `Done` should read as "this shipped". The
 *   web board hides this lane behind the archive toggle.
 */
export type TaskLifecycle =
  | "pending"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "archived";

/** Workflow order, left-to-right — the order the board paints its lanes. */
export const TASK_LIFECYCLES: readonly TaskLifecycle[] = [
  "pending",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "archived",
] as const;

/**
 * Status → lane. The single source of truth for the lifecycle taxonomy:
 * `TASK_STATUSES_BY_LIFECYCLE` is derived from this map, so the forward
 * and reverse directions cannot drift apart.
 */
export const TASK_LIFECYCLE_OF: Record<TaskStatus, TaskLifecycle> = {
  pending: "pending",
  assigned: "pending",
  in_progress: "in_progress",
  revision: "in_progress",
  needs_revision: "in_progress",
  blocked: "blocked",
  review: "in_review",
  done: "done",
  failed: "archived",
  cancelled: "archived",
};

/**
 * Lane → statuses, inverted from {@link TASK_LIFECYCLE_OF} at module load.
 * Backs the SQL status filter behind `GET /task?lifecycle=`, so the rows
 * the server returns are exactly the ones the requested lane displays.
 */
export const TASK_STATUSES_BY_LIFECYCLE: Record<TaskLifecycle, readonly TaskStatus[]> =
  TASK_LIFECYCLES.reduce(
    (acc, lane) => {
      acc[lane] = TASK_STATUSES.filter((s) => TASK_LIFECYCLE_OF[s] === lane);
      return acc;
    },
    {} as Record<TaskLifecycle, TaskStatus[]>,
  );

export function taskLifecycleOf(status: TaskStatus): TaskLifecycle {
  return TASK_LIFECYCLE_OF[status];
}

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
