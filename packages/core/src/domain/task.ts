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
