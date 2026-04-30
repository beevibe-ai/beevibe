/**
 * Memory-fact views — list facts grouped by scope, joined with agent_label.
 *
 * Note: memory facts in core are typically queried by vector-search (per
 * agent, top-k by embedding similarity). The web's memory page wants a
 * simple flat list filtered by scope, scoped to the caller's owner — so
 * this query joins agent.owner_id and filters there.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { FactType, MemoryScope } from "@beevibe/core";
import type { MemoryFactDisplay, MergeOrigin } from "./types.js";

interface FactRow {
  id: string;
  agent_id: string;
  scope: MemoryScope;
  fact_type: FactType;
  content: string;
  source_session_ids: string[];
  created_at: Date;
  agent_label: string;
}

const LIST_SQL = /* sql */ `
SELECT
  f.id, f.agent_id, f.scope, f.fact_type, f.content,
  f.source_session_ids, f.created_at,
  a.name AS agent_label
FROM memory_fact f
JOIN agent a ON a.id = f.agent_id
WHERE a.owner_id = $1
  AND ($2::text IS NULL OR f.scope = $2)
ORDER BY f.created_at DESC
LIMIT 200
`;

export interface MemoryFactsFilter {
  scope?: MemoryScope;
}

export async function listMemoryFacts(
  pool: Pool,
  ownerId: string,
  filter: MemoryFactsFilter = {},
): Promise<MemoryFactDisplay[]> {
  const { rows } = await pool.query<FactRow>(LIST_SQL, [
    ownerId,
    filter.scope ?? null,
  ]);
  return rows.map(rowToMemoryFactDisplay);
}

function rowToMemoryFactDisplay(row: FactRow): MemoryFactDisplay {
  // Heuristic merge_origin from source_session_ids:
  //   - 0 sessions: shouldn't happen, but treat as "single"
  //   - 1 session: "single"
  //   - 2+ sessions: "merged"
  // The "promoted" case (cross-scope promotion) needs an explicit signal
  // that core doesn't currently surface — defer.
  const count = row.source_session_ids?.length ?? 0;
  let merge_origin: MergeOrigin | undefined;
  if (count >= 2) merge_origin = "merged";
  else if (count === 1) merge_origin = "single";

  return {
    id: row.id,
    content: row.content,
    fact_type: row.fact_type,
    scope: row.scope,
    agent_id: row.agent_id,
    agent_label: row.agent_label,
    source_session_count: count,
    created_at: row.created_at,
    merge_origin,
  };
}
