import type {
  TaskWatch,
  TaskWatchMode,
  TaskWatchStatus,
} from "../../domain/task-watch.js";
import type {
  NewTaskWatch,
  TaskWatchRepository,
} from "../../ports/task-watch-repo.js";
import type { Pool } from "./client.js";
import { findRowById } from "./pg-helpers.js";
import type { TaskWatchRow } from "./row-types.js";

export class PostgresTaskWatchRepository implements TaskWatchRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<TaskWatch | undefined> {
    return findRowById(this.pool, "task_watch", id, rowToTaskWatch);
  }

  async create(input: NewTaskWatch): Promise<TaskWatch> {
    if (input.task_ids.length === 0) {
      throw new Error("task_watch.task_ids must be non-empty");
    }
    const { rows } = await this.pool.query<TaskWatchRow>(
      `INSERT INTO task_watch (
         id, waiter_session_id, agent_id, mode, task_ids, reason, status
       ) VALUES (
         $1, $2, $3, $4, $5, $6, COALESCE($7, 'waiting')
       )
       RETURNING *`,
      [
        input.id,
        input.waiter_session_id,
        input.agent_id,
        input.mode,
        input.task_ids,
        input.reason ?? null,
        input.status ?? null,
      ],
    );
    return rowToTaskWatch(rows[0]!);
  }

  async markFired(id: string, firedSessionId: string): Promise<TaskWatch> {
    // Idempotent fired→fired re-call: don't overwrite the original
    // `fired_at` / `fired_session_id`. Refuse waiting→fired races where
    // the row was aborted in between by failing the WHERE.
    const { rows } = await this.pool.query<TaskWatchRow>(
      `UPDATE task_watch
          SET status = 'fired',
              fired_at = COALESCE(fired_at, NOW()),
              fired_session_id = COALESCE(fired_session_id, $2)
        WHERE id = $1
          AND status IN ('waiting', 'fired')
        RETURNING *`,
      [id, firedSessionId],
    );
    if (!rows[0]) {
      throw new Error(
        `task_watch ${id} not in a fire-able state (missing or aborted)`,
      );
    }
    return rowToTaskWatch(rows[0]);
  }

  async markAborted(id: string): Promise<TaskWatch> {
    const { rows } = await this.pool.query<TaskWatchRow>(
      `UPDATE task_watch
          SET status = 'aborted'
        WHERE id = $1
          AND status IN ('waiting', 'aborted')
        RETURNING *`,
      [id],
    );
    if (!rows[0]) {
      throw new Error(
        `task_watch ${id} not in an abortable state (missing or already fired)`,
      );
    }
    return rowToTaskWatch(rows[0]);
  }
}

function rowToTaskWatch(row: TaskWatchRow): TaskWatch {
  return {
    id: row.id,
    waiter_session_id: row.waiter_session_id,
    agent_id: row.agent_id,
    mode: row.mode as TaskWatchMode,
    task_ids: row.task_ids,
    reason: row.reason ?? undefined,
    status: row.status as TaskWatchStatus,
    created_at: row.created_at,
    fired_at: row.fired_at ?? undefined,
    fired_session_id: row.fired_session_id ?? undefined,
  };
}
