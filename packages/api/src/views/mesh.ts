/**
 * Mesh view — pure-data composer for the mesh activity page.
 *
 * V1 ships from the `negotiation` table only (the canonical multi-round
 * mesh activity, well-grounded in M6's persistence). Mesh-ask sessions
 * (`session WHERE type = 'mesh_ask'`) and blocker sessions encode their
 * caller in the intent XML attribute rather than a column, which makes
 * SQL-side joining awkward; surfacing them is a follow-up.
 *
 * 4 queries fired in parallel:
 *   - `asks`     — recent + in-flight negotiations + agent labels + round-1 message
 *   - `nodes`    — distinct agents involved in mesh activity in the window
 *   - `edges`    — aggregated initiator → counterparty pairs with counts
 *   - `summary`  — totals (asks_24h, in_flight, edge_count)
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { HierarchyLevel } from "@beevibe/core";
import type {
  MeshOverview,
  MeshAskData,
  MeshAskStatus,
  GraphNodeData,
  GraphEdgeData,
  MeshSummaryData,
} from "./types.js";

const ASKS_LIMIT = 50;
const WINDOW = "24 hours";

const ASKS_SQL = /* sql */ `
SELECT
  n.id,
  n.initiator_agent_id     AS caller_id,
  ca.name                  AS caller_label,
  n.counterparty_agent_id  AS target_id,
  ta.name                  AS target_label,
  n.status,
  n.task_id                AS source_task_id,
  n.rounds_completed,
  n.max_rounds,
  n.created_at             AS started_at,
  n.updated_at             AS completed_at_or_updated,
  nr1.message              AS intent
FROM negotiation n
JOIN agent ca ON ca.id = n.initiator_agent_id
JOIN agent ta ON ta.id = n.counterparty_agent_id
LEFT JOIN negotiation_round nr1
  ON nr1.negotiation_id = n.id AND nr1.round_number = 1
WHERE n.created_at >= NOW() - INTERVAL '${WINDOW}'
   OR n.status = 'active'
ORDER BY n.created_at DESC
LIMIT $1
`;

/**
 * Single negotiation scan, unpivoted into per-endpoint rows, then GROUP BY
 * agent. `bool_or(status='active')` derives the live-state without a
 * second pass over the table.
 */
const NODES_SQL = /* sql */ `
WITH endpoints AS (
  SELECT initiator_agent_id AS agent_id, status FROM negotiation
  WHERE created_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'active'
  UNION ALL
  SELECT counterparty_agent_id AS agent_id, status FROM negotiation
  WHERE created_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'active'
)
SELECT
  a.id,
  a.name                       AS label,
  a.hierarchy_level            AS hier,
  bool_or(ep.status = 'active') AS is_active
FROM endpoints ep
JOIN agent a ON a.id = ep.agent_id
GROUP BY a.id, a.name, a.hierarchy_level
ORDER BY
  CASE a.hierarchy_level WHEN 'org' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
  a.name ASC
`;

const EDGES_SQL = /* sql */ `
SELECT
  initiator_agent_id    AS from_id,
  counterparty_agent_id AS to_id,
  COUNT(*)::int         AS count,
  bool_or(status = 'active') AS has_live
FROM negotiation
WHERE created_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'active'
GROUP BY initiator_agent_id, counterparty_agent_id
ORDER BY count DESC
`;

const SUMMARY_SQL = /* sql */ `
SELECT
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${WINDOW}')::int  AS asks_24h,
  COUNT(*) FILTER (WHERE status = 'active')::int                           AS in_flight,
  COUNT(DISTINCT (initiator_agent_id, counterparty_agent_id))::int         AS edge_count
FROM negotiation
WHERE created_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'active'
`;

interface AsksRow {
  id: string;
  caller_id: string;
  caller_label: string;
  target_id: string;
  target_label: string;
  status: string;
  source_task_id: string | null;
  rounds_completed: number;
  max_rounds: number;
  started_at: Date;
  completed_at_or_updated: Date;
  intent: string | null;
}

interface NodesRow {
  id: string;
  label: string;
  hier: HierarchyLevel;
  is_active: boolean;
}

interface EdgesRow {
  from_id: string;
  to_id: string;
  count: number;
  has_live: boolean;
}

interface SummaryRow {
  asks_24h: number;
  in_flight: number;
  edge_count: number;
}

/** Map negotiation.status → the UI's coarser ask-status display. */
function mapStatus(raw: string): MeshAskStatus {
  switch (raw) {
    case "active":
      return "in_flight";
    case "accepted":
      return "succeeded";
    case "rejected":
      return "rejected";
    case "escalated":
      return "escalated";
    case "cancelled":
      return "blocked";
    default:
      return "in_flight";
  }
}

export async function getMeshOverview(pool: Pool): Promise<MeshOverview> {
  const [asksResult, nodesResult, edgesResult, summaryResult] = await Promise.all([
    pool.query<AsksRow>(ASKS_SQL, [ASKS_LIMIT]),
    pool.query<NodesRow>(NODES_SQL),
    pool.query<EdgesRow>(EDGES_SQL),
    pool.query<SummaryRow>(SUMMARY_SQL),
  ]);

  const asks: MeshAskData[] = asksResult.rows.map((r) => {
    const status = mapStatus(r.status);
    const isTerminal = status !== "in_flight";
    return {
      id: r.id,
      type: "negotiate",
      caller_id: r.caller_id,
      caller_label: r.caller_label,
      target_id: r.target_id,
      target_label: r.target_label,
      status,
      intent: r.intent ?? "(no message)",
      started_at: r.started_at,
      completed_at: isTerminal ? r.completed_at_or_updated : undefined,
      source_task_id: r.source_task_id ?? undefined,
      rounds_completed: Number(r.rounds_completed),
      max_rounds: Number(r.max_rounds),
    };
  });

  const nodes: GraphNodeData[] = nodesResult.rows.map((r) => ({
    id: r.id,
    label: r.label,
    hier: r.hier,
    state: r.is_active ? "active" : "idle",
  }));

  const edges: GraphEdgeData[] = edgesResult.rows.map((r) => ({
    from: r.from_id,
    to: r.to_id,
    count: Number(r.count),
    state: r.has_live ? "live" : "completed",
  }));

  const summaryRow = summaryResult.rows[0];
  const summary: MeshSummaryData = {
    asks_24h: summaryRow ? Number(summaryRow.asks_24h) : 0,
    in_flight: summaryRow ? Number(summaryRow.in_flight) : 0,
    edge_count: summaryRow ? Number(summaryRow.edge_count) : 0,
  };

  return { asks, graph: { nodes, edges }, summary };
}
