import type {
  Session,
  SessionBriefingSnapshot,
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
import { buildPatchClause } from "./pg-helpers.js";
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

  async listChatForAgent(agentId: string, limit: number): Promise<Session[]> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT * FROM session
        WHERE agent_id = $1 AND type = 'chat' AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT $2`,
      [agentId, limit],
    );
    return rows.map(rowToSession);
  }

  async softDeleteChatChain(headId: string, agentId: string): Promise<number> {
    // Walk backwards from the head through `prior_session_id` and stamp
    // `deleted_at` on every session in the chain. Single roundtrip via
    // recursive CTE. Scoped to agentId so the head must belong to the
    // caller's agent — otherwise the CTE base case is empty and nothing
    // is updated.
    const { rowCount } = await this.pool.query(
      `WITH RECURSIVE chain(id, prior_session_id) AS (
         SELECT id, prior_session_id
           FROM session
          WHERE id = $1
            AND agent_id = $2
            AND type = 'chat'
            AND deleted_at IS NULL
         UNION ALL
         SELECT s.id, s.prior_session_id
           FROM session s
           JOIN chain c ON s.id = c.prior_session_id
          WHERE s.deleted_at IS NULL
       )
       UPDATE session
          SET deleted_at = now()
        WHERE id IN (SELECT id FROM chain)`,
      [headId, agentId],
    );
    return rowCount ?? 0;
  }

  async countRunningByAgent(agentId: string, types: SessionType[]): Promise<number> {
    if (types.length === 0) return 0;
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM session
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

  async listDaemonOrphaned(opts: {
    sessionStaleSeconds: number;
    runtimeHeartbeatStaleSeconds: number;
  }): Promise<Session[]> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT s.* FROM session s
         JOIN runtime r ON r.id = s.runtime_id
        WHERE s.status = 'running'
          AND s.runtime_id IS NOT NULL
          AND COALESCE(s.last_event_at, s.created_at) < now() - ($1 * INTERVAL '1 second')
          AND COALESCE(r.last_heartbeat, r.created_at) < now() - ($2 * INTERVAL '1 second')
        ORDER BY s.created_at ASC`,
      [opts.sessionStaleSeconds, opts.runtimeHeartbeatStaleSeconds],
    );
    return rows.map(rowToSession);
  }

  async claimNextForRuntime(runtimeId: string): Promise<Session | undefined> {
    const { rows } = await this.pool.query<SessionRow>(
      `WITH candidate AS (
         SELECT id FROM session
           WHERE runtime_id = $1
             AND status = 'pending'
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
       )
       UPDATE session
          SET status = 'running',
              started_at = COALESCE(started_at, now())
         FROM candidate
        WHERE session.id = candidate.id
        RETURNING session.*`,
      [runtimeId],
    );
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  async claimNextForServerFallback(): Promise<Session | undefined> {
    const { rows } = await this.pool.query<SessionRow>(
      `WITH candidate AS (
         SELECT id FROM session
           WHERE runtime_id IS NULL
             AND status = 'pending'
           ORDER BY created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
       )
       UPDATE session
          SET status = 'running',
              started_at = COALESCE(started_at, now())
         FROM candidate
        WHERE session.id = candidate.id
        RETURNING session.*`,
    );
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  async countOwnedByDaemon(
    daemonId: string,
    sessionIds: string[],
  ): Promise<number> {
    if (sessionIds.length === 0) return 0;
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM session s
         JOIN runtime r ON r.id = s.runtime_id
        WHERE s.id = ANY($1::text[])
          AND r.daemon_id = $2`,
      [sessionIds, daemonId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async findLatestForAgentInRoom(
    agentId: string,
    roomId: string,
  ): Promise<Session | undefined> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT * FROM session
        WHERE agent_id = $1 AND room_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [agentId, roomId],
    );
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  async listRunningInRoom(roomId: string): Promise<Session[]> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT * FROM session
        WHERE room_id = $1 AND status = 'running'
        ORDER BY started_at ASC`,
      [roomId],
    );
    return rows.map(rowToSession);
  }

  async create(input: NewSession): Promise<Session> {
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO session (
         id, agent_id, task_id, prior_session_id,
         type, status, intent,
         cli_session_id, workspace_path,
         process_pid, process_group_id,
         result_summary, exit_code, error, usage,
         runtime_id, spawn_mode, room_id, caller_agent_id,
         started_at, completed_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, COALESCE($6, 'running'), $7,
         $8, $9,
         $10, $11,
         $12, $13, $14, $15,
         $16, COALESCE($17, 'daemon'), $18, $19,
         $20, NULL
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
        input.workspace_path ?? null,
        input.process_pid ?? null,
        input.process_group_id ?? null,
        input.result_summary ?? null,
        input.exit_code ?? null,
        input.error ?? null,
        input.usage ?? null,
        input.runtime_id ?? null,
        input.spawn_mode ?? null,
        input.room_id ?? null,
        input.caller_agent_id ?? null,
        input.started_at ?? null,
      ],
    );
    return rowToSession(rows[0]!);
  }

  async update(id: string, patch: SessionPatch): Promise<Session> {
    const clause = buildPatchClause<SessionPatch>(patch, {
      prior_session_id: "prior_session_id",
      status: "status",
      intent: "intent",
      cli_session_id: "cli_session_id",
      workspace_path: "workspace_path",
      process_pid: "process_pid",
      process_group_id: "process_group_id",
      result_summary: "result_summary",
      exit_code: "exit_code",
      error: "error",
      usage: "usage",
      briefing: "briefing",
      runtime_id: "runtime_id",
      spawn_mode: "spawn_mode",
      last_event_at: "last_event_at",
      started_at: "started_at",
      completed_at: "completed_at",
    });

    if (clause.fields.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Session not found: ${id}`);
      return existing;
    }

    const { rows } = await this.pool.query<SessionRow>(
      `UPDATE session SET ${clause.fields.join(", ")} WHERE id = $${clause.nextIndex} RETURNING *`,
      [...clause.values, id],
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
    workspace_path: row.workspace_path ?? undefined,
    process_pid: row.process_pid ?? undefined,
    process_group_id: row.process_group_id ?? undefined,
    result_summary: row.result_summary ?? undefined,
    exit_code: row.exit_code ?? undefined,
    error: row.error ?? undefined,
    usage: (row.usage ?? undefined) as SessionUsage | undefined,
    briefing: (row.briefing ?? undefined) as SessionBriefingSnapshot | undefined,
    runtime_id: row.runtime_id ?? undefined,
    spawn_mode: row.spawn_mode,
    last_event_at: row.last_event_at ?? undefined,
    room_id: row.room_id ?? undefined,
    caller_agent_id: row.caller_agent_id ?? undefined,
    started_at: row.started_at ?? undefined,
    completed_at: row.completed_at ?? undefined,
    created_at: row.created_at,
  };
}
