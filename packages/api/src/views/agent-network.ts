/**
 * Agent network view — the caller's own team plus every other user's
 * team-and-tree shown as peer orbits.
 *
 * The pitch is "teams of specialists working alongside other teams";
 * the agent graph is the discovery surface for that. The previous
 * room-membership gate left new users (and anyone who hadn't created
 * rooms yet) invisible to each other — bootstrapping a collaboration
 * required already knowing the other person, which defeats the point.
 *
 * Today the cross-owner surface is open: every non-archived agent
 * belonging to someone other than the caller is a potential peer. The
 * UI still groups by owner so the rendering reads as "Daniel's team"
 * rather than a flat list.
 *
 * `owner_label` is the person's name; rendered next to the team agent
 * avatar so peer orbits read as "Daniel's team", not just "Roadmap".
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { RuntimeConfig } from "@beevibe/core";
import { firstNonEmptyLine } from "./format.js";
import type { AgentDisplay, AgentNetwork, AgentPeerOwner } from "./types.js";

// Defensive cap on the peer fetch. The agent graph is one orbit per
// owner (~5 agents each); 500 rows covers roughly 100 owners' trees.
// Beyond that we'd want owner-level pagination, but cutting at row
// level here is fine as a tripwire — payload size stays bounded and
// the UI is unusable with 100+ orbits anyway.
const PEERS_LIMIT = 500;

const SELF_SQL = /* sql */ `
SELECT
  a.id, a.name, a.owner_id, a.parent_agent_id, a.hierarchy_level,
  a.review_policy, a.runtime_config, a.preferred_runtime_id,
  a.created_at, a.updated_at,
  COALESCE(sc.n, 0)::int  AS sessions_count,
  COALESCE(fc.n, 0)::int  AS facts_learned,
  tl.content              AS tag_line
FROM agent a
LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM session GROUP BY agent_id) sc
  ON sc.agent_id = a.id
LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM memory_fact GROUP BY agent_id) fc
  ON fc.agent_id = a.id
LEFT JOIN core_memory_block tl ON tl.agent_id = a.id AND tl.block_name = 'tag_line'
WHERE a.owner_id = $1
  AND a.archived_at IS NULL
ORDER BY
  CASE a.hierarchy_level WHEN 'org' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
  a.name ASC
`;

// Peer agents — every non-archived agent owned by someone other than
// the caller. The UI groups by owner_id (preserved by ORDER BY) so each
// peer team renders as one satellite orbit; team rows come first within
// each owner bucket so the orbit's centre is the team agent and ICs
// trail.
const PEERS_SQL = /* sql */ `
SELECT
  a.id, a.name, a.owner_id, a.parent_agent_id, a.hierarchy_level,
  a.review_policy, a.runtime_config, a.preferred_runtime_id,
  a.created_at, a.updated_at,
  p.name AS owner_label,
  COALESCE(sc.n, 0)::int  AS sessions_count,
  COALESCE(fc.n, 0)::int  AS facts_learned,
  tl.content              AS tag_line
FROM agent a
JOIN person p ON p.id = a.owner_id
LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM session GROUP BY agent_id) sc
  ON sc.agent_id = a.id
LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM memory_fact GROUP BY agent_id) fc
  ON fc.agent_id = a.id
LEFT JOIN core_memory_block tl ON tl.agent_id = a.id AND tl.block_name = 'tag_line'
WHERE a.owner_id <> $1
  AND a.archived_at IS NULL
ORDER BY a.owner_id,
  CASE a.hierarchy_level WHEN 'org' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
  a.name ASC
LIMIT ${PEERS_LIMIT}
`;

interface AgentRow {
  id: string;
  name: string;
  owner_id: string;
  parent_agent_id: string | null;
  hierarchy_level: "ic" | "team" | "org";
  review_policy: string | null;
  runtime_config: RuntimeConfig;
  preferred_runtime_id: string | null;
  created_at: Date;
  updated_at: Date;
  sessions_count: string | number;
  facts_learned: string | number;
  tag_line: string | null;
}

interface PeerRow extends AgentRow {
  owner_label: string;
}

function rowToAgentDisplay(row: AgentRow): AgentDisplay {
  // PR #96 split runtime (CLI tool) from model (LLM alias). Match `agents.ts`
  // so the network UI shows "claude" not "claude-opus-4-7" under the Runtime
  // label.
  const runtime = row.runtime_config.type ?? "claude";
  const model = row.runtime_config.model;
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
    review_policy: (row.review_policy ?? undefined) as AgentDisplay["review_policy"],
    preferred_runtime_id: row.preferred_runtime_id ?? undefined,
  };
}

export async function getAgentNetwork(
  pool: Pool,
  personId: string,
): Promise<AgentNetwork> {
  // Fire both queries in parallel — they don't depend on each other,
  // and serializing would mean two round-trips for one page render.
  const [selfRes, peersRes] = await Promise.all([
    pool.query<AgentRow>(SELF_SQL, [personId]),
    pool.query<PeerRow>(PEERS_SQL, [personId]),
  ]);

  const self = selfRes.rows.map(rowToAgentDisplay);

  // Group peer rows by owner so the UI can render one orbit per peer.
  // Order preserved from the SQL (owner_id ASC, then hierarchy weight).
  const peersByOwner = new Map<string, AgentPeerOwner>();
  for (const row of peersRes.rows) {
    const existing = peersByOwner.get(row.owner_id);
    if (existing) {
      existing.agents.push(rowToAgentDisplay(row));
    } else {
      peersByOwner.set(row.owner_id, {
        owner_id: row.owner_id,
        owner_label: row.owner_label,
        agents: [rowToAgentDisplay(row)],
      });
    }
  }

  return {
    self,
    peers: Array.from(peersByOwner.values()),
  };
}
