/**
 * Agent views — `AgentDisplay[]` (list) and `AgentDetail` (single).
 * Detail joins core memory blocks, recent sessions (last 5), and outgoing
 * mesh hints (negotiations the agent has initiated). Like tasks, this goes
 * direct-to-pool with hand-rolled SQL — no core repos.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { HierarchyLevel, SessionStatus } from "@beevibe/core";
import { deriveShortId, firstNonEmptyLine, formatRelativeShort } from "./format.js";
import type {
  AgentDisplay,
  AgentDetail,
  CoreBlockDisplay,
  RecentSession,
  OutgoingMeshHint,
  AgentMetrics,
} from "./types.js";

interface AgentRow {
  id: string;
  name: string;
  owner_id: string;
  owner_label: string | null;
  parent_agent_id: string | null;
  hierarchy_level: HierarchyLevel;
  review_policy: string | null;
  runtime_config: Record<string, unknown>;
  preferred_runtime_id: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
  sessions_count: string;
  facts_learned: string;
  tag_line: string | null;
}

const LIST_SQL = /* sql */ `
SELECT
  a.id, a.name, a.owner_id, a.parent_agent_id, a.hierarchy_level,
  a.review_policy, a.runtime_config, a.preferred_runtime_id, a.archived_at,
  a.created_at, a.updated_at,
  p.name                  AS owner_label,
  COALESCE(sc.n, 0)::int  AS sessions_count,
  COALESCE(fc.n, 0)::int  AS facts_learned,
  tl.content              AS tag_line
FROM agent a
LEFT JOIN person p ON p.id = a.owner_id
LEFT JOIN (
  SELECT agent_id, COUNT(*)::int AS n
  FROM session
  GROUP BY agent_id
) sc ON sc.agent_id = a.id
LEFT JOIN (
  SELECT agent_id, COUNT(*)::int AS n
  FROM memory_fact
  GROUP BY agent_id
) fc ON fc.agent_id = a.id
LEFT JOIN core_memory_block tl ON tl.agent_id = a.id AND tl.block_name = 'tag_line'
WHERE ($1::text IS NULL OR a.owner_id = $1)
  AND a.archived_at IS NULL
ORDER BY
  CASE a.hierarchy_level WHEN 'org' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
  a.name ASC
`;

function rowToAgentDisplay(row: AgentRow): AgentDisplay {
  // `runtime` is the CLI tool name; `model` is the LLM alias passed to it.
  // PR #96 split them. `specialization` is the first non-empty line of the
  // `tag_line` core memory block (≤100 chars by template). No fallback to
  // `domain` — that block is for the agent's enduring expertise prose, not
  // a UI headline; mixing the two confused agents with set tag_lines whose
  // cards still showed the domain text.
  const runtime = (row.runtime_config?.type as string | undefined) ?? "claude";
  const model = row.runtime_config?.model as string | undefined;
  const specialization = firstNonEmptyLine(row.tag_line);
  return {
    id: row.id,
    name: row.name,
    owner_id: row.owner_id,
    owner_label: row.owner_label ?? undefined,
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
    archived_at: row.archived_at ? row.archived_at.toISOString() : undefined,
  };
}

export async function listAgents(
  pool: Pool,
  ownerId?: string,
): Promise<AgentDisplay[]> {
  const { rows } = await pool.query<AgentRow>(LIST_SQL, [ownerId ?? null]);
  return rows.map(rowToAgentDisplay);
}

const DETAIL_SQL_AGENT = /* sql */ `
SELECT
  a.id, a.name, a.owner_id, a.parent_agent_id, a.hierarchy_level,
  a.review_policy, a.runtime_config, a.preferred_runtime_id, a.archived_at,
  a.created_at, a.updated_at,
  p.name AS owner_label,
  (SELECT COUNT(*)::int FROM session       WHERE agent_id = a.id) AS sessions_count,
  (SELECT COUNT(*)::int FROM memory_fact   WHERE agent_id = a.id) AS facts_learned,
  (SELECT content FROM core_memory_block
    WHERE agent_id = a.id AND block_name = 'tag_line' LIMIT 1) AS tag_line
FROM agent a
LEFT JOIN person p ON p.id = a.owner_id
WHERE a.id = $1
LIMIT 1
`;

const DETAIL_SQL_BLOCKS = /* sql */ `
SELECT id, agent_id, block_name, content, char_limit, is_system, updated_at
FROM core_memory_block
WHERE agent_id = $1
ORDER BY block_name ASC
`;

const DETAIL_SQL_RECENT_SESSIONS = /* sql */ `
SELECT
  s.id, s.intent, s.status, s.task_id, s.created_at,
  t.title AS task_title
FROM session s
LEFT JOIN task t ON t.id = s.task_id
WHERE s.agent_id = $1
ORDER BY s.created_at DESC
LIMIT 5
`;

/**
 * Aggregated 7-day delta metrics for the agent detail page. One round-trip:
 *   - sessions_change: count(session) WHERE created_at > 7d ago, minus
 *     count(session) WHERE 7d ≤ created_at < 14d ago
 *   - merges: count(memory_fact) for this agent where source_session_ids
 *     has 2+ entries (heuristic — a fact merged from multiple sessions)
 *   - promoted: count of memory_promotion_event rows for this agent where
 *     rejected = false
 */
const DETAIL_SQL_DELTA_METRICS = /* sql */ `
SELECT
  (
    SELECT COUNT(*)::int FROM session
    WHERE agent_id = $1 AND created_at >= NOW() - INTERVAL '7 days'
  ) - (
    SELECT COUNT(*)::int FROM session
    WHERE agent_id = $1
      AND created_at >= NOW() - INTERVAL '14 days'
      AND created_at <  NOW() - INTERVAL '7 days'
  ) AS sessions_change,
  (
    SELECT COUNT(*)::int FROM memory_fact
    WHERE agent_id = $1 AND array_length(source_session_ids, 1) >= 2
  ) AS merges,
  (
    SELECT COUNT(*)::int FROM memory_promotion_event
    WHERE origin_agent_id = $1 AND rejected = false
  ) AS promoted
`;

const DETAIL_SQL_MESH_HINTS = /* sql */ `
SELECT
  n.id,
  cp.name        AS target_name,
  n.created_at,
  (
    SELECT nr.message
    FROM negotiation_round nr
    WHERE nr.negotiation_id = n.id AND nr.from_agent_id = n.initiator_agent_id
    ORDER BY nr.round_number ASC
    LIMIT 1
  ) AS opening_message
FROM negotiation n
JOIN agent cp ON cp.id = n.counterparty_agent_id
WHERE n.initiator_agent_id = $1
  AND n.status NOT IN ('completed', 'escalated_resolved')
ORDER BY n.created_at DESC
LIMIT 3
`;

interface BlockRow {
  id: string;
  agent_id: string;
  block_name: string;
  content: string;
  char_limit: number;
  is_system: boolean;
  updated_at: Date;
}

interface RecentSessionRow {
  id: string;
  intent: string;
  status: SessionStatus;
  task_id: string | null;
  created_at: Date;
  task_title: string | null;
}

interface MeshHintRow {
  id: string;
  target_name: string;
  created_at: Date;
  opening_message: string | null;
}

interface DeltaMetricsRow {
  sessions_change: number;
  merges: number;
  promoted: number;
}

function recentSessionStatus(s: SessionStatus): RecentSession["status"] {
  // Display contract narrows to running/succeeded/review (review is mapped
  // from sessions whose parent task is in review — but cheapest path is
  // map non-running succeeded → succeeded, others → succeeded too. Finer
  // grain can come later.)
  if (s === "running") return "running";
  return "succeeded";
}

export async function getAgent(
  pool: Pool,
  id: string,
): Promise<AgentDetail | undefined> {
  const [agentResult, blockResult, recentResult, meshResult, deltaResult] =
    await Promise.all([
      pool.query<AgentRow>(DETAIL_SQL_AGENT, [id]),
      pool.query<BlockRow>(DETAIL_SQL_BLOCKS, [id]),
      pool.query<RecentSessionRow>(DETAIL_SQL_RECENT_SESSIONS, [id]),
      pool.query<MeshHintRow>(DETAIL_SQL_MESH_HINTS, [id]),
      pool.query<DeltaMetricsRow>(DETAIL_SQL_DELTA_METRICS, [id]),
    ]);
  const agentRow = agentResult.rows[0];
  if (!agentRow) return undefined;
  const deltaRow = deltaResult.rows[0];

  const core_blocks: CoreBlockDisplay[] = blockResult.rows.map((b) => ({
    id: b.id,
    agent_id: b.agent_id,
    block_name: b.block_name,
    content: b.content,
    char_count: b.content.length,
    char_limit: b.char_limit,
    is_system: b.is_system,
    updated_label: `${formatRelativeShort(b.updated_at)} ago`,
  }));

  const recent_sessions: RecentSession[] = recentResult.rows.map((s) => ({
    short_id: deriveShortId(s.id),
    title: s.task_title ?? s.intent,
    status: recentSessionStatus(s.status),
    age: formatRelativeShort(s.created_at),
  }));

  const outgoing_mesh_hints: OutgoingMeshHint[] = meshResult.rows.map((m) => ({
    target: m.target_name,
    intent: (m.opening_message ?? "(no message)").slice(0, 80),
    age: formatRelativeShort(m.created_at),
  }));

  const metrics: AgentMetrics = {
    sessions: Number(agentRow.sessions_count),
    sessions_change: deltaRow ? Number(deltaRow.sessions_change) : 0,
    facts: Number(agentRow.facts_learned),
    merges: deltaRow ? Number(deltaRow.merges) : 0,
    promoted: deltaRow ? Number(deltaRow.promoted) : 0,
  };

  return {
    ...rowToAgentDisplay(agentRow),
    core_blocks,
    metrics,
    recent_sessions,
    outgoing_mesh_hints,
  };
}
