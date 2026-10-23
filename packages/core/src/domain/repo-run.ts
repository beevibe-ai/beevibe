/**
 * Capability Network — `use_repo` invocations and their captured recipes.
 * See migration 1780800000000_add-capability-network.sql for the schema.
 */

import type { SessionEventKind } from "./session.js";

export type RepoRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

/**
 * Kinds the sandbox orchestrator emits. Structurally identical to
 * `TranscriptEvent["kind"]` in `@beevibe/sandbox/orchestrator`, which is
 * declared separately on purpose: the sandbox package takes no dependency
 * on `@beevibe/core` so the trust boundary stays one-way.
 */
export type RepoRunTranscriptKind = "log" | "agent" | "tool_call" | "error";

/**
 * One transcript event from the sandbox orchestrator. The daemon pushes
 * these through /runtime/events so they land in session_event for the UI;
 * a denormalized copy is kept on repo_run.transcript as a per-run
 * snapshot (handy for archive/export).
 */
export interface RepoRunTranscriptEvent {
  at: string;
  /** 'log' and 'error' are sandbox-only; mapped to summary/tool_result in session_event. */
  kind: RepoRunTranscriptKind;
  text: string;
}

/**
 * Transcript kind → `session_event.kind`.
 *
 * The orchestrator emits 'log' and 'error', which the session_event schema
 * doesn't recognize; they fold into 'summary' and 'tool_result' so existing
 * readers still understand them. The fold is injective, so the inverse
 * below recovers the original kind for the playground UI (which colors
 * each transcript kind differently).
 *
 * Writers: `packages/daemon/src/repo-runs.ts` on the way in.
 * Readers: `packages/api/src/routes/repo-runs.ts` on the way out.
 * Both used to carry their own hand-written copy of this table, in
 * opposite directions, each with a comment pointing at the other.
 */
export const REPO_RUN_TRANSCRIPT_TO_SESSION_EVENT: Readonly<
  Record<RepoRunTranscriptKind, SessionEventKind>
> = {
  agent: "agent",
  tool_call: "tool_call",
  log: "summary",
  error: "tool_result",
};

/** Inverse of `REPO_RUN_TRANSCRIPT_TO_SESSION_EVENT`, derived from it. */
const SESSION_EVENT_TO_REPO_RUN_TRANSCRIPT = Object.fromEntries(
  Object.entries(REPO_RUN_TRANSCRIPT_TO_SESSION_EVENT).map(([k, v]) => [v, k]),
) as Readonly<Record<SessionEventKind, RepoRunTranscriptKind>>;

/** Fold an orchestrator transcript kind into the session_event kind stored for it. */
export function transcriptKindToSessionEvent(
  kind: RepoRunTranscriptKind,
): SessionEventKind {
  return REPO_RUN_TRANSCRIPT_TO_SESSION_EVENT[kind];
}

/** Recover the orchestrator transcript kind a session_event kind came from. */
export function sessionEventKindToTranscript(
  kind: SessionEventKind,
): RepoRunTranscriptKind {
  return SESSION_EVENT_TO_REPO_RUN_TRANSCRIPT[kind];
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
