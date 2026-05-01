import type { MemoryPromotionEvent, MemoryScope } from "../../domain/memory.js";
import type {
  MemoryPromotionEventRepository,
  NewMemoryPromotionEvent,
} from "../../ports/promotion-event-repo.js";
import type { Pool } from "./client.js";

interface PromotionEventRow {
  id: string;
  fact_id: string;
  from_scope: string | null;
  to_scope: string;
  origin_agent_id: string;
  promoter_reason: string;
  source_session_ids: string[];
  rejected: boolean;
  created_at: Date;
}

function rowToEvent(row: PromotionEventRow): MemoryPromotionEvent {
  return {
    id: row.id,
    fact_id: row.fact_id,
    from_scope: row.from_scope as MemoryScope | null,
    to_scope: row.to_scope as MemoryScope,
    origin_agent_id: row.origin_agent_id,
    promoter_reason: row.promoter_reason,
    source_session_ids: row.source_session_ids,
    rejected: row.rejected,
    created_at: row.created_at,
  };
}

export class PostgresMemoryPromotionEventRepository
  implements MemoryPromotionEventRepository
{
  constructor(private pool: Pool) {}

  async create(input: NewMemoryPromotionEvent): Promise<MemoryPromotionEvent> {
    const { rows } = await this.pool.query<PromotionEventRow>(
      `INSERT INTO memory_promotion_event (
         id, fact_id, from_scope, to_scope, origin_agent_id,
         promoter_reason, source_session_ids, rejected
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, COALESCE($7::text[], '{}'::text[]), COALESCE($8, false)
       )
       RETURNING *`,
      [
        input.id,
        input.fact_id,
        input.from_scope,
        input.to_scope,
        input.origin_agent_id,
        input.promoter_reason,
        input.source_session_ids,
        input.rejected,
      ],
    );
    if (!rows[0]) throw new Error("memory_promotion_event INSERT returned no row");
    return rowToEvent(rows[0]);
  }

  async listByOwner(ownerId: string, limit: number): Promise<MemoryPromotionEvent[]> {
    const { rows } = await this.pool.query<PromotionEventRow>(
      `SELECT mpe.*
       FROM memory_promotion_event mpe
       JOIN agent a ON a.id = mpe.origin_agent_id
       WHERE a.owner_id = $1
       ORDER BY mpe.created_at DESC
       LIMIT $2`,
      [ownerId, limit],
    );
    return rows.map(rowToEvent);
  }

  async findById(id: string): Promise<MemoryPromotionEvent | undefined> {
    const { rows } = await this.pool.query<PromotionEventRow>(
      `SELECT * FROM memory_promotion_event WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? rowToEvent(rows[0]) : undefined;
  }
}
