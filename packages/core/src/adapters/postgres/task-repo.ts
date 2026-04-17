import type {
  Task,
  TaskStatus,
  TaskPriority,
  CreatorType,
} from "../../domain/task.js";
import type {
  TaskRepository,
  NewTask,
  TaskPatch,
  TaskListFilter,
} from "../../ports/task-repo.js";
import type { Pool } from "./client.js";
import type { TaskRow } from "./row-types.js";

export class PostgresTaskRepository implements TaskRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<Task | undefined> {
    const { rows } = await this.pool.query<TaskRow>(
      `SELECT * FROM task WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToTask(rows[0]) : undefined;
  }

  async list(filter?: TaskListFilter): Promise<Task[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (filter?.status !== undefined) {
      if (Array.isArray(filter.status)) {
        clauses.push(`status = ANY($${i++}::text[])`);
        values.push(filter.status);
      } else {
        clauses.push(`status = $${i++}`);
        values.push(filter.status);
      }
    }
    if (filter?.assignee_id !== undefined) {
      clauses.push(`assignee_id = $${i++}`);
      values.push(filter.assignee_id);
    }
    if (filter?.creator_id !== undefined) {
      clauses.push(`creator_id = $${i++}`);
      values.push(filter.creator_id);
    }
    if (filter?.parent_task_id !== undefined) {
      clauses.push(`parent_task_id = $${i++}`);
      values.push(filter.parent_task_id);
    }
    if (filter?.priority !== undefined) {
      clauses.push(`priority = $${i++}`);
      values.push(filter.priority);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const { rows } = await this.pool.query<TaskRow>(
      `SELECT * FROM task ${where} ORDER BY created_at DESC`,
      values,
    );
    return rows.map(rowToTask);
  }

  async listByAssignee(assigneeId: string): Promise<Task[]> {
    const { rows } = await this.pool.query<TaskRow>(
      `SELECT * FROM task WHERE assignee_id = $1 ORDER BY created_at DESC`,
      [assigneeId],
    );
    return rows.map(rowToTask);
  }

  async listReviewQueue(): Promise<Task[]> {
    // Semantic priority ordering: critical > high > medium > low (not alphabetical).
    // The dispatch partial index (M5 concern) will get a matching expression index
    // when the executor's dispatch query is written.
    const { rows } = await this.pool.query<TaskRow>(
      `SELECT * FROM task
        WHERE status IN ('review', 'revision')
        ORDER BY
          CASE priority
            WHEN 'critical' THEN 4
            WHEN 'high'     THEN 3
            WHEN 'medium'   THEN 2
            WHEN 'low'      THEN 1
            ELSE 0
          END DESC,
          updated_at ASC`,
    );
    return rows.map(rowToTask);
  }

  async countChildrenNotComplete(parentId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM task
        WHERE parent_task_id = $1
          AND status NOT IN ('done', 'cancelled', 'failed')`,
      [parentId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async create(input: NewTask): Promise<Task> {
    const { rows } = await this.pool.query<TaskRow>(
      `INSERT INTO task (
         id, title, description, status, priority,
         assignee_id, creator_id, creator_type, parent_task_id,
         result_summary, blocker_agent_id, blocker_reason
       ) VALUES ($1, $2, $3, COALESCE($4, 'pending'), $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        input.id,
        input.title,
        input.description ?? null,
        input.status ?? null,
        input.priority,
        input.assignee_id ?? null,
        input.creator_id,
        input.creator_type,
        input.parent_task_id ?? null,
        input.result_summary ?? null,
        input.blocker_agent_id ?? null,
        input.blocker_reason ?? null,
      ],
    );
    return rowToTask(rows[0]!);
  }

  async update(id: string, patch: TaskPatch): Promise<Task> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    const set = <K extends keyof TaskPatch>(col: string, key: K) => {
      if (patch[key] !== undefined) {
        fields.push(`${col} = $${i++}`);
        values.push(patch[key] ?? null);
      }
    };

    set("title", "title");
    set("description", "description");
    set("status", "status");
    set("priority", "priority");
    set("assignee_id", "assignee_id");
    set("creator_id", "creator_id");
    set("creator_type", "creator_type");
    set("parent_task_id", "parent_task_id");
    set("result_summary", "result_summary");
    set("blocker_agent_id", "blocker_agent_id");
    set("blocker_reason", "blocker_reason");

    if (fields.length === 0) {
      const existing = await this.findById(id);
      if (!existing) throw new Error(`Task not found: ${id}`);
      return existing;
    }

    fields.push(`updated_at = NOW()`);

    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE task SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      [...values, id],
    );
    if (!rows[0]) throw new Error(`Task not found: ${id}`);
    return rowToTask(rows[0]);
  }

  async updateProgress(id: string, status: TaskStatus, summary: string): Promise<Task> {
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE task
          SET status = $2,
              result_summary = $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, status, summary],
    );
    if (!rows[0]) throw new Error(`Task not found: ${id}`);
    return rowToTask(rows[0]);
  }

  async markBlocked(id: string, blockerAgentId: string, reason: string): Promise<Task> {
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE task
          SET status = 'blocked',
              blocker_agent_id = $2,
              blocker_reason = $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, blockerAgentId, reason],
    );
    if (!rows[0]) throw new Error(`Task not found: ${id}`);
    return rowToTask(rows[0]);
  }

  async clearBlocker(id: string): Promise<Task> {
    const { rows } = await this.pool.query<TaskRow>(
      `UPDATE task
          SET status = 'in_progress',
              blocker_agent_id = NULL,
              blocker_reason = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id],
    );
    if (!rows[0]) throw new Error(`Task not found: ${id}`);
    return rowToTask(rows[0]);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM task WHERE id = $1`, [id]);
  }
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    assignee_id: row.assignee_id ?? undefined,
    creator_id: row.creator_id,
    creator_type: row.creator_type as CreatorType,
    parent_task_id: row.parent_task_id ?? undefined,
    result_summary: row.result_summary ?? undefined,
    blocker_agent_id: row.blocker_agent_id ?? undefined,
    blocker_reason: row.blocker_reason ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
