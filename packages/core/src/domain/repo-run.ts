/**
 * Capability Network — `use_repo` invocations and their captured recipes.
 * See migration 1780800000000_add-capability-network.sql for the schema.
 */

export type RepoRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

/**
 * One transcript event from the sandbox orchestrator. The daemon pushes
 * these through /runtime/events so they land in session_event for the UI;
 * a denormalized copy is kept on repo_run.transcript as a per-run
 * snapshot (handy for archive/export).
 */
export interface RepoRunTranscriptEvent {
  at: string;
  /** 'log' and 'error' are sandbox-only; mapped to summary/tool_result in session_event. */
  kind: "log" | "agent" | "tool_call" | "error";
  text: string;
}

export interface RepoRun {
  id: string;
  session_id?: string;
  task_id?: string;
  agent_id: string;

  goal: string;
  repo_url: string;
  repo_ref?: string;

  status: RepoRunStatus;
  transcript: RepoRunTranscriptEvent[];
  install_log?: string;
  invocation?: string;
  error?: string;

  /** Set when the user captures this run as a reusable skill. */
  learned_skill_id?: string;
  /** Discovery candidates considered for this run (debug only). */
  ranker_candidates?: unknown;

  started_at: Date;
  ended_at?: Date;
}

export type LearnedSkillProvenance = "community";

export interface LearnedSkill {
  id: string;
  name: string;
  goal_pattern: string;
  repo_url: string;
  repo_ref: string;
  install_steps: string;
  invocation: string;

  source_run_id?: string;
  owner_id: string;

  published_to?: LearnedSkillProvenance;
  published_pr?: string;
  published_at?: Date;

  created_at: Date;
  updated_at: Date;
}

export type SkillOutcomeValue = "approved" | "revised" | "rejected";

export interface SkillOutcome {
  id: string;
  learned_skill_id: string;
  repo_run_id: string;
  work_product_id?: string;
  outcome: SkillOutcomeValue;
  reviewer_id?: string;
  recorded_at: Date;
}
