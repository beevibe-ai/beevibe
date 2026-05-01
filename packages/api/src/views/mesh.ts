/**
 * Mesh view — pure-data composer for the mesh activity page.
 *
 * Two activity sources are merged:
 *
 *   1. `negotiation` (multi-round) — full structured rows w/ rounds_completed.
 *   2. `session WHERE type IN ('mesh_ask','blocker')` (one-shot) — caller is
 *      embedded in the intent XML as `from="agent_xxx"`; we extract it via
 *      `substring(... FROM 'from="([^"]+)"')`. Target agent is the row's
 *      agent_id directly.
 *
 * 5 queries fired in parallel:
 *   - `negotiations` — multi-round mesh activity (status='active' OR recent)
 *   - `mesh_sessions` — one-shot ask/blocker sessions (running OR recent)
 *   - `nodes`        — distinct agents involved in mesh activity in the window
 *   - `edges`        — aggregated initiator → counterparty pairs with counts
 *   - `summary`      — totals (asks_24h, in_flight, edge_count)
 *
 * The asks/edges/nodes/summary all union both sources so the activity feed +
 * graph + KPIs reflect the full mesh picture.
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

const NEGOTIATIONS_SQL = /* sql */ `
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
 * One-shot mesh activity (ask + blocker). Caller agent id is embedded in
 * the intent XML as `from="agent_xxx"` — extract via regex. Body is the
 * inner text up to the closing tag (we strip the wrapper for preview).
 */
const MESH_SESSIONS_SQL = /* sql */ `
SELECT
  s.id,
  substring(s.intent FROM 'from="([^"]+)"')                  AS caller_id,
  ca.name                                                     AS caller_label,
  s.agent_id                                                  AS target_id,
  ta.name                                                     AS target_label,
  s.type                                                      AS kind,
  s.status                                                    AS session_status,
  s.task_id                                                   AS source_task_id,
  s.started_at,
  s.completed_at,
  s.intent
FROM session s
LEFT JOIN agent ca
  ON ca.id = substring(s.intent FROM 'from="([^"]+)"')
JOIN agent ta ON ta.id = s.agent_id
WHERE s.type IN ('mesh_ask', 'blocker')
  AND (s.started_at >= NOW() - INTERVAL '${WINDOW}' OR s.status = 'running')
ORDER BY s.started_at DESC
LIMIT $1
`;

/**
 * Endpoints unpivoted from BOTH negotiation rows AND mesh-ask/blocker
 * session rows so the graph reflects the full mesh picture.
 * `bool_or(is_live)` derives node liveness without a second pass.
 */
const NODES_SQL = /* sql */ `
WITH endpoints AS (
  SELECT initiator_agent_id AS agent_id, (status = 'active') AS is_live
  FROM negotiation
  WHERE created_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'active'
  UNION ALL
  SELECT counterparty_agent_id AS agent_id, (status = 'active') AS is_live
  FROM negotiation
  WHERE created_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'active'
  UNION ALL
  SELECT agent_id, (status = 'running') AS is_live
  FROM session
  WHERE type IN ('mesh_ask', 'blocker')
    AND (started_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'running')
  UNION ALL
  SELECT substring(intent FROM 'from="([^"]+)"') AS agent_id, (status = 'running') AS is_live
  FROM session
  WHERE type IN ('mesh_ask', 'blocker')
    AND substring(intent FROM 'from="([^"]+)"') IS NOT NULL
    AND (started_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'running')
)
SELECT
  a.id,
  a.name                       AS label,
  a.hierarchy_level            AS hier,
  bool_or(ep.is_live)           AS is_active
FROM endpoints ep
JOIN agent a ON a.id = ep.agent_id
GROUP BY a.id, a.name, a.hierarchy_level
ORDER BY
  CASE a.hierarchy_level WHEN 'org' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
  a.name ASC
`;

const EDGES_SQL = /* sql */ `
WITH pairs AS (
  SELECT initiator_agent_id AS from_id, counterparty_agent_id AS to_id,
         (status = 'active') AS is_live
  FROM negotiation
  WHERE created_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'active'
  UNION ALL
  SELECT substring(intent FROM 'from="([^"]+)"') AS from_id, agent_id AS to_id,
         (status = 'running') AS is_live
  FROM session
  WHERE type IN ('mesh_ask', 'blocker')
    AND substring(intent FROM 'from="([^"]+)"') IS NOT NULL
    AND (started_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'running')
)
SELECT
  from_id,
  to_id,
  COUNT(*)::int    AS count,
  bool_or(is_live) AS has_live
FROM pairs
GROUP BY from_id, to_id
ORDER BY count DESC
`;

const SUMMARY_SQL = /* sql */ `
WITH activity AS (
  SELECT status = 'active' AS is_live, created_at,
         initiator_agent_id AS a, counterparty_agent_id AS b
  FROM negotiation
  WHERE created_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'active'
  UNION ALL
  SELECT status = 'running' AS is_live, started_at AS created_at,
         substring(intent FROM 'from="([^"]+)"') AS a, agent_id AS b
  FROM session
  WHERE type IN ('mesh_ask', 'blocker')
    AND (started_at >= NOW() - INTERVAL '${WINDOW}' OR status = 'running')
)
SELECT
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '${WINDOW}')::int  AS asks_24h,
  COUNT(*) FILTER (WHERE is_live)::int                                     AS in_flight,
  COUNT(DISTINCT (a, b)) FILTER (WHERE a IS NOT NULL)::int                 AS edge_count
FROM activity
`;

interface NegotiationsRow {
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

interface MeshSessionsRow {
  id: string;
  caller_id: string | null;
  caller_label: string | null;
  target_id: string;
  target_label: string;
  kind: "mesh_ask" | "blocker";
  session_status: "running" | "completed" | "failed" | "cancelled";
  source_task_id: string | null;
  started_at: Date;
  completed_at: Date | null;
  intent: string;
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
function mapNegotiationStatus(raw: string): MeshAskStatus {
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

/** Map session.status → MeshAskStatus for one-shot ask/blocker rows. */
function mapSessionStatus(raw: MeshSessionsRow["session_status"]): MeshAskStatus {
  switch (raw) {
    case "running":
      return "in_flight";
    case "completed":
      return "succeeded";
    case "failed":
      return "blocked";
    case "cancelled":
      return "blocked";
  }
}

/**
 * Pull the inner text out of `<mesh-ask ...>BODY</mesh-ask>` /
 * `<mesh-blocker ...>BODY</mesh-blocker>` for the activity-feed preview.
 * Falls back to the raw intent if the wrapper is missing (defensive — the
 * mesh server always wraps).
 */
function extractMeshIntent(intent: string): string {
  const match = intent.match(/<mesh-(?:ask|blocker)[^>]*>([\s\S]*?)<\/mesh-(?:ask|blocker)>/);
  return (match?.[1] ?? intent).trim() || "(no message)";
}

export async function getMeshOverview(pool: Pool): Promise<MeshOverview> {
  const [negotiationsResult, meshSessionsResult, nodesResult, edgesResult, summaryResult] =
    await Promise.all([
      pool.query<NegotiationsRow>(NEGOTIATIONS_SQL, [ASKS_LIMIT]),
      pool.query<MeshSessionsRow>(MESH_SESSIONS_SQL, [ASKS_LIMIT]),
      pool.query<NodesRow>(NODES_SQL),
      pool.query<EdgesRow>(EDGES_SQL),
      pool.query<SummaryRow>(SUMMARY_SQL),
    ]);

  const negotiationAsks: MeshAskData[] = negotiationsResult.rows.map((r) => {
    const status = mapNegotiationStatus(r.status);
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

  const sessionAsks: MeshAskData[] = meshSessionsResult.rows
    // Drop rows where the from= attribute didn't resolve to an agent — most
    // likely a malformed/legacy intent. Surfacing them with caller_label =
    // null would make the UI render "from null" — better to skip.
    .filter((r) => r.caller_id && r.caller_label)
    .map((r) => ({
      id: r.id,
      type: r.kind === "blocker" ? "blocker" : "ask",
      caller_id: r.caller_id!,
      caller_label: r.caller_label!,
      target_id: r.target_id,
      target_label: r.target_label,
      status: mapSessionStatus(r.session_status),
      intent: extractMeshIntent(r.intent),
      started_at: r.started_at,
      completed_at: r.completed_at ?? undefined,
      source_task_id: r.source_task_id ?? undefined,
    }));

  const asks: MeshAskData[] = [...negotiationAsks, ...sessionAsks].sort(
    (a, b) => b.started_at.getTime() - a.started_at.getTime(),
  );

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
