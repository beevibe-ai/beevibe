/**
 * Agent network view — the caller's own team plus peer teams they
 * collaborate with through shared rooms.
 *
 * The pitch is "teams of specialists working alongside other teams";
 * the data model already supports it (agents have owner_id, rooms link
 * agents from multiple owners), but the /agent list endpoint scopes
 * to the caller's tree. This view is the explicit cross-owner surface.
 *
 * Peer set is derived from co-membership in rooms: for every room the
 * caller is a member of, every agent member of that room whose owner
 * isn't the caller becomes a peer-network anchor. We then rope in that
 * peer's full agent tree (their team + ICs) so the UI can render a
 * complete satellite orbit.
 *
 * `owner_label` is the person's name; rendered next to the team agent
 * avatar so peer orbits read as "Daniel's team", not just "Roadmap".
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { AgentDisplay, AgentNetwork, AgentPeerOwner } from "./types.js";

const SELF_SQL = /* sql */ `
SELECT
  a.id, a.name, a.owner_id, a.parent_agent_id, a.hierarchy_level,
  a.review_policy, a.runtime_config, a.created_at, a.updated_at,
  COALESCE(sc.n, 0)::int  AS sessions_count,
  COALESCE(fc.n, 0)::int  AS facts_learned
FROM agent a
LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM session GROUP BY agent_id) sc
  ON sc.agent_id = a.id
LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM memory_fact GROUP BY agent_id) fc
  ON fc.agent_id = a.id
WHERE a.owner_id = $1
ORDER BY
  CASE a.hierarchy_level WHEN 'org' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
  a.name ASC
`;

// Peer agents — every agent in any room the caller co-attends, scoped
// to OTHER owners so the caller's own agents don't appear twice. Walks
// room_member from caller (kind=person) → shared rooms → agent
// members. Returns the full tree per peer owner so the UI can render
// each peer team's specialists, not just the top-level avatar.
const PEERS_SQL = /* sql */ `
WITH peer_owners AS (
  SELECT DISTINCT a.owner_id
  FROM room_member me
  JOIN room_member rm  ON rm.room_id = me.room_id
  JOIN agent       a   ON a.id = rm.agent_id
  WHERE me.kind = 'person'
    AND me.person_id = $1
    AND rm.kind = 'agent'
    AND a.owner_id <> $1
)
SELECT
  a.id, a.name, a.owner_id, a.parent_agent_id, a.hierarchy_level,
  a.review_policy, a.runtime_config, a.created_at, a.updated_at,
  p.name AS owner_label,
  COALESCE(sc.n, 0)::int  AS sessions_count,
  COALESCE(fc.n, 0)::int  AS facts_learned
FROM agent a
JOIN peer_owners po ON po.owner_id = a.owner_id
JOIN person p       ON p.id = a.owner_id
LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM session GROUP BY agent_id) sc
  ON sc.agent_id = a.id
LEFT JOIN (SELECT agent_id, COUNT(*)::int AS n FROM memory_fact GROUP BY agent_id) fc
  ON fc.agent_id = a.id
ORDER BY a.owner_id,
  CASE a.hierarchy_level WHEN 'org' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
  a.name ASC
`;

interface AgentRow {
  id: string;
  name: string;
  owner_id: string;
  parent_agent_id: string | null;
  hierarchy_level: "ic" | "team" | "org";
  review_policy: string | null;
  runtime_config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  sessions_count: string | number;
  facts_learned: string | number;
}

interface PeerRow extends AgentRow {
  owner_label: string;
}

function rowToAgentDisplay(row: AgentRow): AgentDisplay {
  const runtime = (row.runtime_config?.model as string | undefined) ?? "claude-code";
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
    review_policy: (row.review_policy ?? undefined) as AgentDisplay["review_policy"],
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
