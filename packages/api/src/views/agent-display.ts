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
