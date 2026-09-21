/**
 * The agent-display projection, in one place: the SQL that selects the
 * columns, the row type they come back as, and the mapping into
 * `AgentDisplay`.
 *
 * Three views project the same agent columns into the same display
 * shape: the list (`agents.ts:listAgents`), the detail header
 * (`agents.ts:getAgent`) and the network graph
 * (`agent-network.ts:getAgentNetwork`, for both self and peer orbits).
 * Each used to carry its own copy of the field-by-field mapping, which
 * meant the derivation rules below had to be re-explained — and
 * re-fixed — in each one.
 *
 * The four queries behind those views then still spelled the column
 * list, the stat joins and the hierarchy ordering out by hand, so
 * adding an agent column meant four coordinated edits and one of them
 * was easy to miss. The SQL fragments below are the other half of the
 * same single-source-of-truth: `AgentDisplayRow` describes what
 * `AGENT_BASE_COLUMNS` + `AGENT_STAT_COLUMNS` select, so the type and
 * the query can't drift apart.
 *
 * Callers with extra columns (`owner_label`, `archived_at`) spread the
 * result and add them, so a view only opts into the fields its SQL
 * actually selects.
 */

import type { HierarchyLevel } from "@beevibe/core";
import { firstNonEmptyLine } from "./format.js";
import type { AgentDisplay } from "./types.js";

/**
 * The `agent` columns every display query selects, aliased `a`.
 *
 * Deliberately excludes `a.archived_at`: the list and detail queries
 * select it (they surface archived agents' state), the network queries
 * filter on it but never project it. Views that need it append the
 * column themselves.
 */
export const AGENT_BASE_COLUMNS = /* sql */ `a.id, a.name, a.owner_id, a.parent_agent_id, a.hierarchy_level,
  a.review_policy, a.runtime_config, a.preferred_runtime_id,
  a.created_at, a.updated_at`;

/**
 * The three derived display columns, paired with {@link AGENT_STAT_JOINS}
 * — use both or neither.
 */
export const AGENT_STAT_COLUMNS = /* sql */ `COALESCE(sc.n, 0)::int  AS sessions_count,
  COALESCE(fc.n, 0)::int  AS facts_learned,
  tl.content              AS tag_line`;

/**
 * Joins backing {@link AGENT_STAT_COLUMNS}: per-agent session and fact
 * counts, plus the `tag_line` core-memory block the card's
 * `specialization` line is derived from.
 *
 * Grouped subqueries rather than correlated ones because these run over
 * a whole result set. `getAgent` fetches a single row by id and uses
 * correlated scalar subqueries instead — same columns, but it would
 * otherwise aggregate the entire `session` table to read one agent's
 * count.
 */
export const AGENT_STAT_JOINS = /* sql */ `LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM session GROUP BY agent_id) sc
  ON sc.agent_id = a.id
LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM memory_fact GROUP BY agent_id) fc
  ON fc.agent_id = a.id
LEFT JOIN core_memory_block tl ON tl.agent_id = a.id AND tl.block_name = 'tag_line'`;

/**
 * ORDER BY terms that put an owner's team above its ICs, then sort
 * alphabetically — the reading order every agent surface uses. Goes
 * after any leading grouping term (the peer query orders by
 * `a.owner_id` first so each owner's agents stay one contiguous orbit).
 *
 * `hierarchy_level` is TEXT, so alphabetical DESC would read
 * 'team' > 'org' > 'ic'; the CASE pins the intended rank instead.
 */
export const AGENT_HIERARCHY_ORDER = /* sql */ `CASE a.hierarchy_level WHEN 'org' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
  a.name ASC`;

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
