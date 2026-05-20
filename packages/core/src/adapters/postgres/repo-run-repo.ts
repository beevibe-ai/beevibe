import type {
  LearnedSkill,
  LearnedSkillProvenance,
  RepoRun,
  RepoRunStatus,
  RepoRunTranscriptEvent,
  SkillOutcome,
  SkillOutcomeValue,
} from "../../domain/repo-run.js";
import { skillOutcomeId } from "../../domain/ids.js";
import type {
  LearnedSkillRepository,
  LearnedSkillPatch,
  NewLearnedSkill,
  NewRepoRun,
  NewSkillOutcome,
  RepoRunPatch,
  RepoRunRepository,
  SkillOutcomeRepository,
  SkillOutcomeStats,
} from "../../ports/repo-run-repo.js";
import type { Pool } from "./client.js";

interface RepoRunRow {
  id: string;
  session_id: string | null;
  task_id: string | null;
  agent_id: string;
  goal: string;
  repo_url: string;
  repo_ref: string | null;
  status: string;
  transcript: RepoRunTranscriptEvent[];
  install_log: string | null;
  invocation: string | null;
  error: string | null;
  learned_skill_id: string | null;
  ranker_candidates: unknown;
  started_at: Date;
  ended_at: Date | null;
}

interface LearnedSkillRow {
  id: string;
  name: string;
  goal_pattern: string;
  repo_url: string;
  repo_ref: string;
  install_steps: string;
  invocation: string;
  source_run_id: string | null;
  owner_id: string;
  published_to: string | null;
  published_pr: string | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SkillOutcomeRow {
  id: string;
  learned_skill_id: string;
  repo_run_id: string;
  work_product_id: string | null;
  outcome: string;
  reviewer_id: string | null;
  recorded_at: Date;
}

/** ────────────────────────────── repo_run ────────────────────────────── */

export class PostgresRepoRunRepository implements RepoRunRepository {
  constructor(private pool: Pool) {}

  async create(input: NewRepoRun): Promise<RepoRun> {
    const status = input.status ?? "pending";
    const transcript = input.transcript ?? [];
    const { rows } = await this.pool.query<RepoRunRow>(
      `INSERT INTO repo_run
         (id, session_id, task_id, agent_id, goal, repo_url, repo_ref,
          status, transcript)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.id,
        input.session_id ?? null,
        input.task_id ?? null,
        input.agent_id,
        input.goal,
        input.repo_url,
        input.repo_ref ?? null,
        status,
        JSON.stringify(transcript),
      ],
    );
    return rowToRepoRun(rows[0]!);
  }

  async findById(id: string): Promise<RepoRun | undefined> {
    const { rows } = await this.pool.query<RepoRunRow>(
      `SELECT * FROM repo_run WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToRepoRun(rows[0]) : undefined;
  }

  async findBySessionId(sessionId: string): Promise<RepoRun | undefined> {
    const { rows } = await this.pool.query<RepoRunRow>(
      `SELECT * FROM repo_run WHERE session_id = $1 LIMIT 1`,
      [sessionId],
    );
    return rows[0] ? rowToRepoRun(rows[0]) : undefined;
  }

  async listByAgent(
    agentId: string,
    opts?: { limit?: number },
  ): Promise<RepoRun[]> {
    const limit = opts?.limit ?? 50;
    const { rows } = await this.pool.query<RepoRunRow>(
      `SELECT * FROM repo_run
        WHERE agent_id = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [agentId, limit],
    );
    return rows.map(rowToRepoRun);
  }

  async listRecent(opts?: { limit?: number }): Promise<RepoRun[]> {
    const limit = opts?.limit ?? 50;
    const { rows } = await this.pool.query<RepoRunRow>(
      `SELECT * FROM repo_run
        ORDER BY started_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map(rowToRepoRun);
  }

  async update(id: string, patch: RepoRunPatch): Promise<RepoRun> {
    const { rows } = await this.pool.query<RepoRunRow>(
      `UPDATE repo_run
          SET status            = COALESCE($2, status),
              transcript        = COALESCE($3::jsonb, transcript),
              install_log       = COALESCE($4, install_log),
              invocation        = COALESCE($5, invocation),
              error             = COALESCE($6, error),
              repo_ref          = COALESCE($7, repo_ref),
              learned_skill_id  = COALESCE($8, learned_skill_id),
              ranker_candidates = COALESCE($9::jsonb, ranker_candidates),
              ended_at          = COALESCE($10, ended_at)
        WHERE id = $1
        RETURNING *`,
      [
        id,
        patch.status ?? null,
        patch.transcript !== undefined ? JSON.stringify(patch.transcript) : null,
        normalizeNullable(patch.install_log),
        normalizeNullable(patch.invocation),
        normalizeNullable(patch.error),
        normalizeNullable(patch.repo_ref),
        normalizeNullable(patch.learned_skill_id),
        patch.ranker_candidates !== undefined
          ? JSON.stringify(patch.ranker_candidates)
          : null,
        patch.ended_at ?? null,
      ],
    );
    if (!rows[0]) {
      throw new Error(`repo_run ${id} not found`);
    }
    return rowToRepoRun(rows[0]);
  }
}

/** ───────────────────────────── learned_skill ──────────────────────────── */

export class PostgresLearnedSkillRepository implements LearnedSkillRepository {
  constructor(private pool: Pool) {}

  async create(input: NewLearnedSkill): Promise<LearnedSkill> {
    const { rows } = await this.pool.query<LearnedSkillRow>(
      `INSERT INTO learned_skill
         (id, name, goal_pattern, repo_url, repo_ref, install_steps,
          invocation, source_run_id, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.id,
        input.name,
        input.goal_pattern,
        input.repo_url,
        input.repo_ref,
        input.install_steps,
        input.invocation,
        input.source_run_id ?? null,
        input.owner_id,
      ],
    );
    return rowToLearnedSkill(rows[0]!);
  }

  async findById(id: string): Promise<LearnedSkill | undefined> {
    const { rows } = await this.pool.query<LearnedSkillRow>(
      `SELECT * FROM learned_skill WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToLearnedSkill(rows[0]) : undefined;
  }

  async findByOwnerAndName(
    ownerId: string,
    name: string,
  ): Promise<LearnedSkill | undefined> {
    const { rows } = await this.pool.query<LearnedSkillRow>(
      `SELECT * FROM learned_skill WHERE owner_id = $1 AND name = $2 LIMIT 1`,
      [ownerId, name],
    );
    return rows[0] ? rowToLearnedSkill(rows[0]) : undefined;
  }

  async listByOwner(ownerId: string): Promise<LearnedSkill[]> {
    const { rows } = await this.pool.query<LearnedSkillRow>(
      `SELECT * FROM learned_skill
        WHERE owner_id = $1
        ORDER BY created_at DESC`,
      [ownerId],
    );
    return rows.map(rowToLearnedSkill);
  }

  async searchByGoal(
    ownerId: string,
    goal: string,
    opts?: { limit?: number },
  ): Promise<LearnedSkill[]> {
    const limit = opts?.limit ?? 10;
    // websearch_to_tsquery handles bare phrases like "extract tables from PDF"
    // without needing user-supplied tsquery syntax.
    const { rows } = await this.pool.query<LearnedSkillRow>(
      `SELECT * FROM learned_skill
        WHERE owner_id = $1
          AND to_tsvector('english', goal_pattern)
              @@ websearch_to_tsquery('english', $2)
        ORDER BY ts_rank(
                   to_tsvector('english', goal_pattern),
                   websearch_to_tsquery('english', $2)
                 ) DESC,
                 created_at DESC
        LIMIT $3`,
      [ownerId, goal, limit],
    );
    return rows.map(rowToLearnedSkill);
  }

  async update(id: string, patch: LearnedSkillPatch): Promise<LearnedSkill> {
    const { rows } = await this.pool.query<LearnedSkillRow>(
      `UPDATE learned_skill
          SET goal_pattern  = COALESCE($2, goal_pattern),
              install_steps = COALESCE($3, install_steps),
              invocation    = COALESCE($4, invocation),
              repo_ref      = COALESCE($5, repo_ref),
              published_to  = COALESCE($6, published_to),
              published_pr  = COALESCE($7, published_pr),
              published_at  = COALESCE($8, published_at),
              updated_at    = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        id,
        patch.goal_pattern ?? null,
        patch.install_steps ?? null,
        patch.invocation ?? null,
        patch.repo_ref ?? null,
        normalizeNullable(patch.published_to),
        normalizeNullable(patch.published_pr),
        patch.published_at ?? null,
      ],
    );
    if (!rows[0]) {
      throw new Error(`learned_skill ${id} not found`);
    }
    return rowToLearnedSkill(rows[0]);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM learned_skill WHERE id = $1`, [id]);
  }
}

/** ───────────────────────────── skill_outcome ──────────────────────────── */

export class PostgresSkillOutcomeRepository implements SkillOutcomeRepository {
  constructor(private pool: Pool) {}

  async upsert(input: NewSkillOutcome): Promise<SkillOutcome> {
    const { rows } = await this.pool.query<SkillOutcomeRow>(
      `INSERT INTO skill_outcome
         (id, learned_skill_id, repo_run_id, work_product_id, outcome, reviewer_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (learned_skill_id, repo_run_id)
       DO UPDATE SET
         outcome         = EXCLUDED.outcome,
         work_product_id = EXCLUDED.work_product_id,
         reviewer_id     = EXCLUDED.reviewer_id,
         recorded_at     = NOW()
       RETURNING *`,
      [
        input.id,
        input.learned_skill_id,
        input.repo_run_id,
        input.work_product_id ?? null,
        input.outcome,
        input.reviewer_id ?? null,
      ],
    );
    return rowToSkillOutcome(rows[0]!);
  }

  async listBySkill(
    skillId: string,
    opts?: { limit?: number },
  ): Promise<SkillOutcome[]> {
    const limit = opts?.limit ?? 50;
    const { rows } = await this.pool.query<SkillOutcomeRow>(
      `SELECT * FROM skill_outcome
        WHERE learned_skill_id = $1
        ORDER BY recorded_at DESC
        LIMIT $2`,
      [skillId, limit],
    );
    return rows.map(rowToSkillOutcome);
  }

  async statsForSkill(
    skillId: string,
    opts?: { recentLimit?: number },
  ): Promise<SkillOutcomeStats> {
    const recentLimit = opts?.recentLimit ?? 10;
    // Single round trip: aggregate counts + the most-recent N rows.
    const [aggResult, recentResult] = await Promise.all([
      this.pool.query<{ outcome: string; n: string }>(
        `SELECT outcome, COUNT(*)::text AS n
           FROM skill_outcome
          WHERE learned_skill_id = $1
          GROUP BY outcome`,
        [skillId],
      ),
      this.pool.query<SkillOutcomeRow>(
        `SELECT * FROM skill_outcome
          WHERE learned_skill_id = $1
          ORDER BY recorded_at DESC
          LIMIT $2`,
        [skillId, recentLimit],
      ),
    ]);

    let total = 0;
    let approved = 0;
    let revised = 0;
    let rejected = 0;
    for (const row of aggResult.rows) {
      const n = parseInt(row.n, 10);
      total += n;
      if (row.outcome === "approved") approved = n;
      else if (row.outcome === "revised") revised = n;
      else if (row.outcome === "rejected") rejected = n;
    }
    return {
      total,
      approved,
      revised,
      rejected,
      recent: recentResult.rows.map(rowToSkillOutcome),
    };
  }
}

/** Generate a fresh skill_outcome id when callers don't supply one. */
export function newSkillOutcomeId(): string {
  return skillOutcomeId();
}

/* ─────────────────────────── row mappers ─────────────────────────────── */

function rowToRepoRun(row: RepoRunRow): RepoRun {
  return {
    id: row.id,
    session_id: row.session_id ?? undefined,
    task_id: row.task_id ?? undefined,
    agent_id: row.agent_id,
    goal: row.goal,
    repo_url: row.repo_url,
    repo_ref: row.repo_ref ?? undefined,
    status: row.status as RepoRunStatus,
    transcript: row.transcript ?? [],
    install_log: row.install_log ?? undefined,
    invocation: row.invocation ?? undefined,
    error: row.error ?? undefined,
    learned_skill_id: row.learned_skill_id ?? undefined,
    ranker_candidates: row.ranker_candidates ?? undefined,
    started_at: row.started_at,
    ended_at: row.ended_at ?? undefined,
  };
}

function rowToLearnedSkill(row: LearnedSkillRow): LearnedSkill {
  return {
    id: row.id,
    name: row.name,
    goal_pattern: row.goal_pattern,
    repo_url: row.repo_url,
    repo_ref: row.repo_ref,
    install_steps: row.install_steps,
    invocation: row.invocation,
    source_run_id: row.source_run_id ?? undefined,
    owner_id: row.owner_id,
    published_to: (row.published_to as LearnedSkillProvenance | null) ?? undefined,
    published_pr: row.published_pr ?? undefined,
    published_at: row.published_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToSkillOutcome(row: SkillOutcomeRow): SkillOutcome {
  return {
    id: row.id,
    learned_skill_id: row.learned_skill_id,
    repo_run_id: row.repo_run_id,
    work_product_id: row.work_product_id ?? undefined,
    outcome: row.outcome as SkillOutcomeValue,
    reviewer_id: row.reviewer_id ?? undefined,
    recorded_at: row.recorded_at,
  };
}

/**
 * Patch fields support three sentinels:
 *   undefined  → leave column unchanged (COALESCE returns existing value)
 *   null       → explicitly clear (we treat as "no change" here — set the
 *                  column explicitly if you really need to clear it)
 *   value      → set
 *
 * For MVP we treat null the same as undefined to avoid unintended clears.
 */
function normalizeNullable<T>(v: T | null | undefined): T | null {
  if (v === undefined || v === null) return null;
  return v;
}
