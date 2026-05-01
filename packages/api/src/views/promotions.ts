/**
 * Promotions view — FactPromoter decision audit feed for the Promotions
 * page. Sourced from `memory_promotion_event` (M8.D), joined with
 * `memory_fact` for content + type and `agent` for the originator's label.
 *
 * `rejected` rows are surfaced too — the page shows the LLM's reasoning
 * for "kept narrow" decisions, not just promotions.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { FactType, MemoryScope } from "@beevibe/core";
import type { PromotionEvent } from "./types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const SESSION_PREVIEW = 3;

// memory_promotion_event.fact_id has ON DELETE CASCADE, so an event row
// can never outlive its fact. INNER JOIN both sides — no defensive
// LEFT-JOIN-with-fallbacks needed.
const LIST_SQL = /* sql */ `
SELECT
  mpe.id,
  mpe.fact_id,
  mpe.from_scope,
  mpe.to_scope,
  mpe.origin_agent_id,
  mpe.promoter_reason,
  mpe.source_session_ids,
  mpe.rejected,
  mpe.created_at,
  f.fact_type      AS fact_type,
  f.content        AS fact_content,
  a.name           AS origin_agent_label
FROM memory_promotion_event mpe
JOIN agent a       ON a.id = mpe.origin_agent_id
JOIN memory_fact f ON f.id = mpe.fact_id
WHERE a.owner_id = $1
ORDER BY mpe.created_at DESC
LIMIT $2
`;

interface EventRow {
  id: string;
  fact_id: string;
  from_scope: MemoryScope | null;
  to_scope: MemoryScope;
  origin_agent_id: string;
  promoter_reason: string;
  source_session_ids: string[];
  rejected: boolean;
  created_at: Date;
  fact_type: FactType;
  fact_content: string;
  origin_agent_label: string;
}

export interface PromotionsFilter {
  /** Default 100, clamped 1..500. */
  limit?: number;
}

export async function listPromotions(
  pool: Pool,
  ownerId: string,
  filter: PromotionsFilter = {},
): Promise<PromotionEvent[]> {
  const limit = Math.min(
    Math.max(1, filter.limit ?? DEFAULT_LIMIT),
    MAX_LIMIT,
  );
  const { rows } = await pool.query<EventRow>(LIST_SQL, [ownerId, limit]);
  return rows.map(rowToPromotionEvent);
}

function rowToPromotionEvent(row: EventRow): PromotionEvent {
  const allSessions = row.source_session_ids ?? [];
  const preview = allSessions.slice(0, SESSION_PREVIEW);
  const extra = Math.max(0, allSessions.length - preview.length);
  return {
    id: row.id,
    fact_id: row.fact_id,
    fact_type: row.fact_type,
    fact_content: row.fact_content,
    from_scope: row.from_scope,
    to_scope: row.to_scope,
    origin_agent_id: row.origin_agent_id,
    origin_agent_label: row.origin_agent_label,
    promoter_reason: row.promoter_reason,
    source_session_ids: preview,
    source_session_extra: extra > 0 ? extra : undefined,
    created_at: row.created_at,
    rejected: row.rejected,
  };
}
