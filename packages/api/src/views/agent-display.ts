/**
 * The `agent` row → `AgentDisplay` mapping, in one place.
 *
 * Three views project the same agent columns into the same display
 * shape: the list (`agents.ts:listAgents`), the detail header
 * (`agents.ts:getAgent`) and the network graph
 * (`agent-network.ts:getAgentNetwork`, for both self and peer orbits).
 * Each used to carry its own copy of the field-by-field mapping, which
 * meant the derivation rules below had to be re-explained — and
 * re-fixed — in each one.
 *
 * Callers with extra columns (`owner_label`, `archived_at`) spread the
 * result and add them, so a view only opts into the fields its SQL
 * actually selects.
 */

import type { HierarchyLevel } from "@beevibe/core";
import { firstNonEmptyLine } from "./format.js";
import type { AgentDisplay } from "./types.js";

/**
 * The columns every agent view selects. Widened where the callers
 * disagree: counts come back as `int` (number) from the network's
 * `COALESCE(...)::int` and as a string from `COUNT(*)` elsewhere, and
 * `runtime_config` is read as loose JSON because it arrives straight
 * from a jsonb column.
 */
export interface AgentDisplayRow {
  id: string;
  name: string;
  owner_id: string;
  parent_agent_id: string | null;
  hierarchy_level: HierarchyLevel;
  review_policy: string | null;
  runtime_config: Record<string, unknown> | null;
  preferred_runtime_id: string | null;
  created_at: Date;
  updated_at: Date;
  sessions_count: string | number;
  facts_learned: string | number;
  tag_line: string | null;
}

export function toAgentDisplay(row: AgentDisplayRow): AgentDisplay {
  // PR #96 split runtime (the CLI tool) from model (the LLM alias
  // passed to it), so the UI shows "claude" under the Runtime label
  // rather than "claude-opus-4-7". Agents predating the split have no
  // `type`, hence the default.
  const cfg = row.runtime_config ?? {};
  const runtime = (cfg.type as string | undefined) ?? "claude";
  const model = cfg.model as string | undefined;

  // `specialization` is the first non-empty line of the `tag_line` core
  // memory block (≤100 chars by template). Deliberately no fallback to
  // `domain`: that block holds the agent's enduring expertise prose,
  // not a UI headline, and mixing the two left agents with a set
  // tag_line still showing their domain text on the card.
  const specialization = firstNonEmptyLine(row.tag_line);

  return {
    id: row.id,
    name: row.name,
    owner_id: row.owner_id,
    parent_agent_id: row.parent_agent_id ?? undefined,
    hierarchy_level: row.hierarchy_level,
    created_at: row.created_at,
    updated_at: row.updated_at,
    display_name: row.name,
    hierarchy: row.hierarchy_level,
    sessions_count: Number(row.sessions_count),
    facts_learned: Number(row.facts_learned),
    runtime,
    model,
    specialization,
    review_policy: row.review_policy ?? undefined,
    preferred_runtime_id: row.preferred_runtime_id ?? undefined,
  };
}

// ── Shared SQL ────────────────────────────────────────────────────────
//
// The mapping above is only half the story: the four queries that feed
// it (`agents.ts` LIST_SQL + DETAIL_SQL_AGENT, `agent-network.ts`
// SELF_SQL + PEERS_SQL) had each spelled out the same ten-column list,
// the same three derived columns and the same tier ordering by hand.
// Adding a field to `AgentDisplayRow` meant editing four SELECTs across
// two files and there was nothing to catch a miss — the row type is
// structural, so a query that forgot a column type-checked fine and
// failed at `toAgentDisplay` with `undefined`.
//
// The fragments below are the single source of truth for the
// projection. Each query still owns its own FROM / WHERE / LIMIT and
// its own `person` join, which is what genuinely differs between them:
// the list left-joins `person` for `owner_label`, the peers query
// inner-joins it (a peer without an owner row is not renderable), and
// the self query skips it because the caller already is the owner.
//
// These are constants from this module, never caller input, so
// interpolating them into a template literal is safe.

/**
 * The `agent` columns backing {@link AgentDisplayRow}, aliased off `a`.
 * Selected verbatim by all four agent views.
 */
export const AGENT_BASE_COLUMNS = /* sql */ `
  a.id, a.name, a.owner_id, a.parent_agent_id, a.hierarchy_level,
  a.review_policy, a.runtime_config, a.preferred_runtime_id,
  a.created_at, a.updated_at`;

/**
 * The three derived columns of {@link AgentDisplayRow}, in the
 * grouped-join form. Pairs with {@link AGENT_DERIVED_JOINS} — use both
 * or neither.
 */
export const AGENT_DERIVED_COLUMNS = /* sql */ `
  COALESCE(sc.n, 0)::int  AS sessions_count,
  COALESCE(fc.n, 0)::int  AS facts_learned,
  tl.content              AS tag_line`;

/** Supplies `sc` / `fc` / `tl` for {@link AGENT_DERIVED_COLUMNS}. */
export const AGENT_DERIVED_JOINS = /* sql */ `
LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM session GROUP BY agent_id) sc
  ON sc.agent_id = a.id
LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM memory_fact GROUP BY agent_id) fc
  ON fc.agent_id = a.id
LEFT JOIN core_memory_block tl ON tl.agent_id = a.id AND tl.block_name = 'tag_line'`;

/**
 * The same three derived columns as correlated subqueries, for the
 * single-row detail fetch.
 *
 * Deliberately a second form rather than a reuse of
 * {@link AGENT_DERIVED_COLUMNS}: those joins aggregate `session` and
 * `memory_fact` in full before the join, which is the right plan when
 * the query returns every agent but wasteful when `WHERE a.id = $1`
 * wants exactly one. Postgres can push the id predicate into a
 * correlated subquery and cannot push it through the GROUP BY.
 *
 * Must stay column-for-column identical to
 * {@link AGENT_DERIVED_COLUMNS} — same names, same types — since both
 * feed {@link toAgentDisplay}.
 */
export const AGENT_DERIVED_SUBQUERIES = /* sql */ `
  (SELECT COUNT(*)::int FROM session     WHERE agent_id = a.id) AS sessions_count,
  (SELECT COUNT(*)::int FROM memory_fact WHERE agent_id = a.id) AS facts_learned,
  (SELECT content FROM core_memory_block
    WHERE agent_id = a.id AND block_name = 'tag_line' LIMIT 1)  AS tag_line`;

/**
 * Tier-then-name ordering: org agents first, then team, then ICs, with
 * agents sorted by name inside each tier. Shared by the list and both
 * network queries so the three surfaces agree on agent order.
 */
export const AGENT_TIER_ORDER = /* sql */ `
  CASE a.hierarchy_level WHEN 'org' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
  a.name ASC`;
