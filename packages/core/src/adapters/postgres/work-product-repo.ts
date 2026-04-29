import type { WorkProduct, WorkProductType } from "../../domain/work-product.js";
import type {
  WorkProductRepository,
  NewWorkProduct,
  WorkProductPatch,
} from "../../ports/work-product-repo.js";
import type { Pool } from "./client.js";
import type { WorkProductRow } from "./row-types.js";

export class PostgresWorkProductRepository implements WorkProductRepository {
  constructor(private pool: Pool) {}

  async findById(id: string): Promise<WorkProduct | undefined> {
    const { rows } = await this.pool.query<WorkProductRow>(
      `SELECT * FROM work_product WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToWorkProduct(rows[0]) : undefined;
  }

  async listByTask(taskId: string): Promise<WorkProduct[]> {
    const { rows } = await this.pool.query<WorkProductRow>(
      `SELECT * FROM work_product
        WHERE task_id = $1
        ORDER BY created_at DESC`,
      [taskId],
    );
    return rows.map(rowToWorkProduct);
  }

  async listByAgent(agentId: string): Promise<WorkProduct[]> {
    const { rows } = await this.pool.query<WorkProductRow>(
      `SELECT * FROM work_product
        WHERE agent_id = $1
        ORDER BY created_at DESC`,
      [agentId],
    );
    return rows.map(rowToWorkProduct);
  }

  async create(input: NewWorkProduct): Promise<WorkProduct> {
    const { rows } = await this.pool.query<WorkProductRow>(
      `INSERT INTO work_product (
         id, task_id, agent_id, type, title,
         summary, url, provider, external_id, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.id,
        input.task_id,
        input.agent_id,
        input.type,
        input.title,
        input.summary ?? null,
        input.url ?? null,
        input.provider ?? null,
        input.external_id ?? null,
        input.metadata ?? null,
      ],
    );
    return rowToWorkProduct(rows[0]!);
  }

  async update(id: string, patch: WorkProductPatch): Promise<WorkProduct> {
    // Mutable: summary, url, provider, external_id, metadata.
    // Each `??` lets the caller leave a field unchanged with `undefined`.
    const { rows } = await this.pool.query<WorkProductRow>(
      `UPDATE work_product
          SET summary     = COALESCE($2, summary),
              url         = COALESCE($3, url),
              provider    = COALESCE($4, provider),
              external_id = COALESCE($5, external_id),
              metadata    = COALESCE($6, metadata),
              updated_at  = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        id,
        patch.summary ?? null,
        patch.url ?? null,
        patch.provider ?? null,
        patch.external_id ?? null,
        patch.metadata ?? null,
      ],
    );
    if (!rows[0]) {
      throw new Error(`work_product ${id} not found`);
    }
    return rowToWorkProduct(rows[0]);
  }

  async delete(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM work_product WHERE id = $1`, [id]);
  }
}

function rowToWorkProduct(row: WorkProductRow): WorkProduct {
  return {
    id: row.id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    type: row.type as WorkProductType,
    title: row.title,
    summary: row.summary ?? undefined,
    url: row.url ?? undefined,
    provider: row.provider ?? undefined,
    external_id: row.external_id ?? undefined,
    metadata: row.metadata ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
