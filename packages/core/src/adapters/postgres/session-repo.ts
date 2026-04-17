import type {
  Session,
  SessionStatus,
  SessionType,
  SessionUsage,
} from "../../domain/session.js";
import type {
  SessionRepository,
  NewSession,
  SessionPatch,
} from "../../ports/session-repo.js";
import type { Pool } from "./client.js";
import type { SessionRow } from "./row-types.js";

export class PostgresSessionRepository implements SessionRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Session | undefined> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT * FROM session WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  async findLatestForTask(taskId: string): Promise<Session | undefined> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT * FROM session
        WHERE task_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [taskId],
    );
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  async listForTask(taskId: string): Promise<Session[]> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT * FROM session
        WHERE task_id = $1
        ORDER BY created_at DESC`,
      [taskId],
    );
    return rows.map(rowToSession);
  }

  async listForAgent(agentId: string): Promise<Session[]> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT * FROM session
        WHERE agent_id = $1
        ORDER BY created_at DESC`,
      [agentId],
    );
    return rows.map(rowToSession);
  }

  async countRunningByAgent(agentId: string, types: SessionType[]): Promise<number> {
    if (types.length === 0) return 0;
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM session
        WHERE agent_id = $1
          AND status = 'running'
          AND type = ANY($2::text[])`,
      [agentId, types],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async listRunningWithPid(): Promise<Session[]> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT * FROM session
        WHERE status = 'running' AND process_pid IS NOT NULL
        ORDER BY created_at ASC`,
    );
    return rows.map(rowToSession);
  }

  async create(input: NewSession): Promise<Session> {
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO session (
         id, agent_id, task_id, prior_session_id,
         type, status, intent,
         cli_session_id, worktree_path, branch_name,
         process_pid, process_group_id,
         result_summary, exit_code, error, usage,
         started_at, completed_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, COALESCE($6, 'running'), $7,
         $8, $9, $10,
         $11, $12,
         $13, $14, $15, $16,
         $17, NULL
       )
       RETURNING *`,
      [
        input.id,
        input.agent_id,
        input.task_id ?? null,
        input.prior_session_id ?? null,
        input.type,
        input.status ?? null,
        input.intent,
        input.cli_session_id ?? null,
        input.worktree_path ?? null,
        input.branch_name ?? null,
        input.process_pid ?? null,
        input.process_group_id ?? null,
        input.result_summary ?? null,
        input.exit_code ?? null,
        input.error ?? null,
        input.usage ?? null,
        input.started_at ?? null,
      ],
    );
    return rowToSession(rows[0]!);
  }

  async update(id: string, patch: SessionPatch): Promise<Session> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const set = (col: string, val: unknown) => {
      if (val !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(val ?? null);
      }
    };

    set("prior_session_id", patch.prior_session_id);
    set("status", patch.status);
    set("intent", patch.intent);
    set("cli_session_id", patch.cli_session_id);
    set("worktree_path", patch.worktree_path);
    set("branch_name", patch.branch_name);
    set("process_pid", patch.process_pid);
    set("process_group_id", patch.process_group_id);
    set("result_summary", patch.result_summary);
    set("exit_code", patch.exit_code);
    set("error", patch.error);
    set("usage", patch.usage);
    set("started_at", patch.started_at);
    set("completed_at", patch.completed_at);

    if (fields.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Session not found: ${id}`);
      return existing;
    }

    const { rows } = await this.pool.query<SessionRow>(
      `UPDATE session SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      [...values, id],
    );
    if (!rows[0]) throw new Error(`Session not found: ${id}`);
    return rowToSession(rows[0]);
  }
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    agent_id: row.agent_id,
    task_id: row.task_id ?? undefined,
    prior_session_id: row.prior_session_id ?? undefined,
    type: row.type as SessionType,
    status: row.status as SessionStatus,
    intent: row.intent,
    cli_session_id: row.cli_session_id ?? undefined,
    worktree_path: row.worktree_path ?? undefined,
    branch_name: row.branch_name ?? undefined,
    process_pid: row.process_pid ?? undefined,
    process_group_id: row.process_group_id ?? undefined,
    result_summary: row.result_summary ?? undefined,
    exit_code: row.exit_code ?? undefined,
    error: row.error ?? undefined,
    usage: (row.usage ?? undefined) as SessionUsage | undefined,
    started_at: row.started_at ?? undefined,
    completed_at: row.completed_at ?? undefined,
    created_at: row.created_at,
  };
}
