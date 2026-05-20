import type {
  LearnedSkill,
  LearnedSkillProvenance,
  RepoRun,
  RepoRunStatus,
  RepoRunTranscriptEvent,
  SkillOutcome,
  SkillOutcomeValue,
} from "../domain/repo-run.js";

export type NewRepoRun = Omit<
  RepoRun,
  "started_at" | "ended_at" | "transcript" | "status" | "install_log" | "invocation" | "error" | "learned_skill_id" | "ranker_candidates"
> & {
  status?: RepoRunStatus;
  transcript?: RepoRunTranscriptEvent[];
};

export interface RepoRunPatch {
  status?: RepoRunStatus;
  transcript?: RepoRunTranscriptEvent[];
  install_log?: string | null;
  invocation?: string | null;
  error?: string | null;
  repo_ref?: string | null;
  learned_skill_id?: string | null;
  ranker_candidates?: unknown;
  ended_at?: Date | null;
}

export interface RepoRunRepository {
  create(input: NewRepoRun): Promise<RepoRun>;
  findById(id: string): Promise<RepoRun | undefined>;
  findBySessionId(sessionId: string): Promise<RepoRun | undefined>;
  listByAgent(agentId: string, opts?: { limit?: number }): Promise<RepoRun[]>;
  listRecent(opts?: { limit?: number }): Promise<RepoRun[]>;
  update(id: string, patch: RepoRunPatch): Promise<RepoRun>;
}

export type NewLearnedSkill = Omit<
  LearnedSkill,
  "created_at" | "updated_at" | "published_to" | "published_pr" | "published_at"
>;

export interface LearnedSkillPatch {
  goal_pattern?: string;
  install_steps?: string;
  invocation?: string;
  repo_ref?: string;
  published_to?: LearnedSkillProvenance | null;
  published_pr?: string | null;
  published_at?: Date | null;
}

export interface LearnedSkillRepository {
  create(input: NewLearnedSkill): Promise<LearnedSkill>;
  findById(id: string): Promise<LearnedSkill | undefined>;
  findByOwnerAndName(ownerId: string, name: string): Promise<LearnedSkill | undefined>;
  listByOwner(ownerId: string): Promise<LearnedSkill[]>;
  /** Full-text match against goal_pattern; used by the discovery ranker. */
  searchByGoal(ownerId: string, goal: string, opts?: { limit?: number }): Promise<LearnedSkill[]>;
  update(id: string, patch: LearnedSkillPatch): Promise<LearnedSkill>;
  delete(id: string): Promise<void>;
}

export interface NewSkillOutcome {
  id: string;
  learned_skill_id: string;
  repo_run_id: string;
  work_product_id?: string;
  outcome: SkillOutcomeValue;
  reviewer_id?: string;
}

export interface SkillOutcomeStats {
  total: number;
  approved: number;
  revised: number;
  rejected: number;
  /** Most recent outcomes first, capped by the caller's `limit`. */
  recent: SkillOutcome[];
}

export interface SkillOutcomeRepository {
  /**
   * Upsert by (learned_skill_id, repo_run_id) — review on the same run
   * twice replaces the prior verdict instead of stacking rows.
   */
  upsert(input: NewSkillOutcome): Promise<SkillOutcome>;
  listBySkill(skillId: string, opts?: { limit?: number }): Promise<SkillOutcome[]>;
  statsForSkill(skillId: string, opts?: { recentLimit?: number }): Promise<SkillOutcomeStats>;
}
