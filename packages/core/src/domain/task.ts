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

/**
 * Board lane a task sits in, derived from its status.
 *
 * The web renders one column per lifecycle and the api's `GET /task`
 * accepts one as a `?lifecycle=` filter, so this mapping is a wire
 * contract between the two. It used to exist twice — `packages/web/lib/
 * tasks-grouping.ts` owned the six-lane version the board draws, and
 * `packages/api/src/views/tasks-grouping.ts` carried a four-lane
 * "server-side mirror" of it — and the two had drifted: the api folded
 * `blocked` into `in_review` and `failed`/`cancelled` into `done`, so a
 * filter named after a lane returned rows the lane doesn't hold. Both
 * sides now read this table.
 *
 * The web imports these as *values*, so it must do so via the
 * `@beevibe/core/domain/task` subpath rather than the package root —
 * see the header of `./format.ts` for why the root barrel cannot be
 * value-imported from a client component. Keep this module
 * dependency-free (type-only imports) so it stays bundle-safe.
 */
export type TaskLifecycle =
  | "pending"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "archived";

/**
 * Status → lane.
 *
 * - `blocked` gets its own lane rather than sharing `in_review`: blocked
 *   means waiting on an external dependency, review means waiting on a
 *   human verdict. Different action from whoever reads the board.
 * - `failed` and `cancelled` are terminal-but-not-success, so they land
 *   in `archived` rather than `done` — `done` should read as "shipped".
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
 * Lanes in workflow order, left to right. `blocked` sits between
 * `in_progress` and `in_review` because that is where blockers arise:
 * work started, hit an impasse, needs unblocking before it can land in
 * review. `archived` is last and hidden behind a toggle on the board.
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
 * Lane → the statuses it holds. Inverted from {@link TASK_LIFECYCLE_OF}
 * at module load rather than written out a second time, so the two
 * directions cannot disagree. Backs the api's `?lifecycle=` → SQL
 * status-array translation.
 */
export const TASK_STATUSES_BY_LIFECYCLE: Record<TaskLifecycle, readonly TaskStatus[]> =
  (() => {
    const byLane = Object.fromEntries(
      TASK_LIFECYCLES.map((lane) => [lane, [] as TaskStatus[]]),
    ) as Record<TaskLifecycle, TaskStatus[]>;
    for (const status of TASK_STATUSES) {
      byLane[TASK_LIFECYCLE_OF[status]].push(status);
    }
    return byLane;
  })();

/** Union of the statuses in every one of `lanes`, in `TASK_STATUSES` order. */
export function taskStatusesForLifecycles(
  lanes: readonly TaskLifecycle[],
): readonly TaskStatus[] {
  const wanted = new Set(lanes);
  return TASK_STATUSES.filter((s) => wanted.has(TASK_LIFECYCLE_OF[s]));
}
