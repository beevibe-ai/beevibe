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
import { MEMORY_SCOPES } from "@beevibe/core";
import type { MemoryFactCounts, MemoryFactDisplay, MergeOrigin } from "./types.js";

const MEMORY_SCOPE_SET = new Set<string>(MEMORY_SCOPES);

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
LIMIT $3
`;

export const DEFAULT_MEMORY_FACTS_LIMIT = 200;
export const MAX_MEMORY_FACTS_LIMIT = 1000;

export interface MemoryFactsFilter {
  scope?: MemoryScope;
  /** Default 200, capped at 1000 to keep the response bounded. */
  limit?: number;
}

export async function listMemoryFacts(
  pool: Pool,
  ownerId: string,
  filter: MemoryFactsFilter = {},
): Promise<MemoryFactDisplay[]> {
  const limit = Math.min(
    Math.max(1, filter.limit ?? DEFAULT_MEMORY_FACTS_LIMIT),
    MAX_MEMORY_FACTS_LIMIT,
  );
  const { rows } = await pool.query<FactRow>(LIST_SQL, [
    ownerId,
    filter.scope ?? null,
    limit,
  ]);
  return rows.map(rowToMemoryFactDisplay);
}

/**
 * Per-scope fact counts for the memory page's scope tabs. Owner-scoped
 * and unconditional — the tab counts must stay stable regardless of
 * which scope filter is active on `/memory/fact`, otherwise switching
 * tabs makes the other tabs' badges flash to 0.
 */
const COUNTS_SQL = /* sql */ `
SELECT f.scope, COUNT(*)::int AS n
FROM memory_fact f
JOIN agent a ON a.id = f.agent_id
WHERE a.owner_id = $1
GROUP BY f.scope
`;

interface CountsRow {
  scope: MemoryScope;
  n: number;
}

export async function listMemoryFactCounts(
  pool: Pool,
  ownerId: string,
): Promise<MemoryFactCounts> {
  const { rows } = await pool.query<CountsRow>(COUNTS_SQL, [ownerId]);
  const counts: MemoryFactCounts = { total: 0, ic: 0, team: 0, org: 0 };
  for (const row of rows) {
    // Defensive: if a future migration adds a new MemoryScope and this
    // query runs before the DTO/UI catch up, ignore the unknown bucket
    // rather than corrupting the result with a stray property.
    if (!MEMORY_SCOPE_SET.has(row.scope)) continue;
    counts[row.scope] = row.n;
    counts.total += row.n;
  }
  return counts;
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
