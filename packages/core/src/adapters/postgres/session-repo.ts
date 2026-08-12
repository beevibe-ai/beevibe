import { DEFAULT_TASK_CAP } from "../../domain/agent.js";
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
import { findRowById, taskPriorityRankSql, updateRowById } from "./pg-helpers.js";
import type { SessionRow } from "./row-types.js";

export class PostgresSessionRepository implements SessionRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Session | undefined> {
    return findRowById(this.pool, "session", id, rowToSession);
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

  async listPendingForRuntimeIds(
    runtimeIds: string[],
    limit: number,
  ): Promise<Array<{ id: string; runtime_id: string }>> {
    if (runtimeIds.length === 0 || limit <= 0) return [];
    const { rows } = await this.pool.query<{ id: string; runtime_id: string }>(
      `SELECT id, runtime_id FROM session
        WHERE status = 'pending'
          AND runtime_id = ANY($1::text[])
        ORDER BY created_at ASC
        LIMIT $2`,
      [runtimeIds, limit],
    );
    return rows;
  }

  async claimNextForRuntime(runtimeId: string): Promise<Session | undefined> {
    return this.claimNextWhere("s.runtime_id = $1", [runtimeId]);
  }

  async claimNextForServerFallback(): Promise<Session | undefined> {
    return this.claimNextWhere("s.runtime_id IS NULL", []);
  }

  async cancelPendingForTask(taskId: string): Promise<number> {
    const result = await this.pool.query(
      `UPDATE session
          SET status = 'cancelled',
              completed_at = now(),
              error = 'task_cancelled_before_claim'
        WHERE task_id = $1 AND status = 'pending'`,
      [taskId],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Shared CTE-and-UPDATE body for the two claim paths. The per-agent
   * task-cap gate is inline so the claim is atomic regardless of which
   * surface drove it — the gate used to live in application code on the
   * scheduler side only, so daemon claims could exceed the cap
   * (beevibe-ai/beevibe#127).
   *
   * `FOR UPDATE OF s, a SKIP LOCKED` serializes concurrent claims for
   * the same agent: two claims for two different pending sessions of
   * the same agent can't both pass the count check, because the second
   * has to wait on (or skip past) the agent row lock held by the first.
   * Claims across DIFFERENT agents proceed in parallel.
   *
   * `runtimePredicate` is interpolated, not parameterized — callers
   * supply a literal SQL fragment ("s.runtime_id = $1" or "s.runtime_id
   * IS NULL"), never user input. `DEFAULT_TASK_CAP` rides in as the
   * last positional parameter so the SQL doesn't bake the default into
   * a hardcoded literal that could drift from the domain constant.
   */
  private async claimNextWhere(
    runtimePredicate: string,
    params: unknown[],
  ): Promise<Session | undefined> {
    // Non-task sessions (chat/mesh/blocker/run_repo) have task_id NULL,
    // so they fall into the LEFT JOIN's NULL branch and the outer CASE
    // slots them at the medium tier (= 2): high+critical tasks preempt
    // them, they preempt medium and low tasks. Preserves the prior FIFO
    // ordering within the non-task group.
    const defaultCapParam = `$${params.length + 1}`;
    const { rows } = await this.pool.query<SessionRow>(
      `WITH candidate AS (
         SELECT s.id FROM session s
           JOIN agent a ON a.id = s.agent_id
           LEFT JOIN task t ON t.id = s.task_id
          WHERE ${runtimePredicate}
            AND s.status = 'pending'
            AND (
              s.type != 'task'
              OR (
                SELECT COUNT(*) FROM session s2
                 WHERE s2.agent_id = s.agent_id
                   AND s2.status = 'running'
                   AND s2.type = 'task'
              ) < COALESCE(a.max_task_sessions, ${defaultCapParam})
            )
          ORDER BY
            (CASE WHEN s.type = 'task'
                  THEN ${taskPriorityRankSql("t.priority")}
                  ELSE 2
             END) DESC,
            s.created_at ASC
          FOR UPDATE OF s, a SKIP LOCKED
          LIMIT 1
       )
       UPDATE session
          SET status = 'running',
              started_at = COALESCE(started_at, now())
         FROM candidate
        WHERE session.id = candidate.id
        RETURNING session.*`,
      [...params, DEFAULT_TASK_CAP],
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

  async markAbandonedChatSessions(olderThanMs: number): Promise<number> {
    const seconds = Math.max(0, Math.floor(olderThanMs / 1000));
    // COALESCE(last_event_at, started_at, created_at) gives the freshest
    // signal of activity we have for a chat row. SessionEventRepository
    // touches last_event_at for daemon-bound sessions; human MCP chat
    // sessions don't emit those events, so they fall through to
    // started_at/created_at.
    const { rowCount } = await this.pool.query(
      `UPDATE session
          SET status = 'failed',
              error = 'abandoned_at_restart',
              completed_at = now()
        WHERE status = 'running'
          AND type = 'chat'
          AND COALESCE(last_event_at, started_at, created_at)
              < now() - ($1 * INTERVAL '1 second')`,
      [seconds],
    );
    return rowCount ?? 0;
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
    // conversation_id resolution policy lives in the INSERT itself so
    // every call site (DispatchService, AgentSession's legacy inline
    // path, tests) gets it for free. For chat sessions:
    //   1. an explicit caller-provided conversation_id wins;
    //   2. else inherit from the prior session's conversation_id (the
    //      subselect returns NULL when prior_session_id is NULL or the
    //      prior row is gone — soft-deleted or pruned);
    //   3. else this is a new thread — stamp the row's own id.
    // Non-chat sessions ALWAYS get NULL — the type check guards the
    // whole expression so a caller passing an explicit conversation_id
    // on a task / mesh row can't leak it into the chat-thread index.
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO session (
         id, agent_id, task_id, prior_session_id,
         type, status, intent,
         cli_session_id, workspace_path,
         process_pid, process_group_id,
         result_summary, exit_code, error, usage,
         runtime_id, spawn_mode, room_id, caller_agent_id,
         parent_session_id,
         conversation_id,
         started_at, completed_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, COALESCE($6, 'running'), $7,
         $8, $9,
         $10, $11,
         $12, $13, $14, $15,
         $16, COALESCE($17, 'daemon'), $18, $19,
         $20,
         CASE
           WHEN $5 = 'chat' THEN COALESCE(
             $22::text,
             (SELECT conversation_id FROM session WHERE id = $4),
             $1
           )
           ELSE NULL
         END,
         $21, NULL
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
        input.parent_session_id ?? null,
        input.started_at ?? null,
        input.conversation_id ?? null,
      ],
    );
    return rowToSession(rows[0]!);
  }

  async update(id: string, patch: SessionPatch): Promise<Session> {
    return updateRowById<SessionRow, SessionPatch, Session>({
      pool: this.pool,
      table: "session",
      id,
      patch,
      columns: {
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
      },
      map: rowToSession,
      notFound: (id) => `Session not found: ${id}`,
      touchUpdatedAt: false,
    });
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
    parent_session_id: row.parent_session_id ?? undefined,
    conversation_id: row.conversation_id ?? undefined,
    started_at: row.started_at ?? undefined,
    completed_at: row.completed_at ?? undefined,
    created_at: row.created_at,
  };
}
