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
 *
 * The time window is parameterized via {@link MeshWindow}. `"all"` lifts
 * the time predicate (still capped by the row LIMIT). `asks_24h` stays
 * hardcoded at 24h — it answers "what happened today", not "what's in the
 * current view".
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
  MeshWindow,
} from "./types.js";
import { MESH_WINDOWS } from "./types.js";

const ASKS_LIMIT = 50;
export const DEFAULT_MESH_WINDOW: MeshWindow = "24h";

const WINDOW_INTERVAL: Record<Exclude<MeshWindow, "all">, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

export function isMeshWindow(value: unknown): value is MeshWindow {
  return typeof value === "string" && (MESH_WINDOWS as readonly string[]).includes(value);
}

/**
 * Build the per-source WHERE-fragment pair for a given window. `negWindow`
 * applies to `negotiation` rows (created_at + always-include-active);
 * `sessWindow` to `session` rows (type filter + started_at + always-include-
 * running). `"all"` drops the time predicate entirely (active/running rows
 * were already always-included, so this only widens history).
 *
 * Columns are qualified with `n.` / `s.` so the fragment is safe to drop into
 * queries that also `JOIN agent` — `agent.created_at` collides with
 * `negotiation.created_at` otherwise. The corresponding FROM clauses below
 * therefore alias `negotiation n` and `session s`.
 */
function buildWindowFragments(window: MeshWindow): {
  negWindow: string;
  sessWindow: string;
} {
  if (window === "all") {
    return {
      negWindow: "TRUE",
      sessWindow: "s.type IN ('mesh_ask', 'blocker')",
    };
  }
  const interval = WINDOW_INTERVAL[window];
  return {
    negWindow: `n.created_at >= NOW() - INTERVAL '${interval}' OR n.status = 'active'`,
    sessWindow: `s.type IN ('mesh_ask', 'blocker') AND (s.started_at >= NOW() - INTERVAL '${interval}' OR s.status = 'running')`,
  };
}

// Use the indexed `caller_agent_id` column with a regex fallback for any
// pre-backfill row that slipped through (defense in depth — the migration
// `1780100000000_add-session-caller-agent-id.sql` populated existing rows).
const SESS_FROM = `COALESCE(caller_agent_id, substring(intent FROM 'from="([^"]+)"'))`;

const negotiationsSql = (negWindow: string) => /* sql */ `
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
WHERE ${negWindow}
ORDER BY n.created_at DESC
LIMIT $1
`;

/**
 * One-shot mesh activity (ask + blocker). Caller agent id is embedded in
 * the intent XML as `from="agent_xxx"` — extract via regex. Body is the
 * inner text up to the closing tag (we strip the wrapper for preview).
 */
const meshSessionsSql = (sessWindow: string) => /* sql */ `
SELECT
  s.id,
  ${SESS_FROM}              AS caller_id,
  ca.name                   AS caller_label,
  s.agent_id                AS target_id,
  ta.name                   AS target_label,
  s.type                    AS kind,
  s.status                  AS session_status,
  s.task_id                 AS source_task_id,
  s.started_at,
  s.completed_at,
  s.intent
FROM session s
LEFT JOIN agent ca ON ca.id = ${SESS_FROM}
JOIN agent ta ON ta.id = s.agent_id
WHERE ${sessWindow}
ORDER BY s.started_at DESC
LIMIT $1
`;

/**
 * Endpoints unpivoted from BOTH negotiation rows AND mesh-ask/blocker
 * session rows so the graph reflects the full mesh picture.
 * `bool_or(is_live)` derives node liveness without a second pass.
 */
const nodesSql = (negWindow: string, sessWindow: string) => /* sql */ `
WITH endpoints AS (
  SELECT n.initiator_agent_id AS agent_id, (n.status = 'active') AS is_live
  FROM negotiation n WHERE ${negWindow}
  UNION ALL
  SELECT n.counterparty_agent_id AS agent_id, (n.status = 'active') AS is_live
  FROM negotiation n WHERE ${negWindow}
  UNION ALL
  SELECT s.agent_id, (s.status = 'running') AS is_live
  FROM session s WHERE ${sessWindow}
  UNION ALL
  SELECT ${SESS_FROM} AS agent_id, (s.status = 'running') AS is_live
  FROM session s WHERE ${sessWindow} AND ${SESS_FROM} IS NOT NULL
)
SELECT
  a.id,
  a.name                       AS label,
  a.hierarchy_level            AS hier,
  bool_or(ep.is_live)          AS is_active
FROM endpoints ep
JOIN agent a ON a.id = ep.agent_id
GROUP BY a.id, a.name, a.hierarchy_level
ORDER BY
  CASE a.hierarchy_level WHEN 'org' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,
  a.name ASC
`;

const edgesSql = (negWindow: string, sessWindow: string) => /* sql */ `
WITH pairs AS (
  SELECT n.initiator_agent_id AS from_id, n.counterparty_agent_id AS to_id,
         (n.status = 'active') AS is_live
  FROM negotiation n WHERE ${negWindow}
  UNION ALL
  SELECT ${SESS_FROM} AS from_id, s.agent_id AS to_id,
         (s.status = 'running') AS is_live
  FROM session s WHERE ${sessWindow} AND ${SESS_FROM} IS NOT NULL
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

const summarySql = (negWindow: string, sessWindow: string) => /* sql */ `
WITH activity AS (
  SELECT (n.status = 'active') AS is_live, n.created_at,
         n.initiator_agent_id AS a, n.counterparty_agent_id AS b
  FROM negotiation n WHERE ${negWindow}
  UNION ALL
  SELECT (s.status = 'running') AS is_live, s.started_at AS created_at,
         ${SESS_FROM} AS a, s.agent_id AS b
  FROM session s WHERE ${sessWindow}
)
SELECT
  COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int  AS asks_24h,
  COUNT(*) FILTER (WHERE is_live)::int                                    AS in_flight,
  COUNT(DISTINCT (a, b)) FILTER (WHERE a IS NOT NULL)::int                AS edge_count
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

/**
 * Lookup table from raw negotiation/session status to the UI's coarser
 * MeshAskStatus. Both sources collapse to the same 5-value display enum;
 * unknown values default to "in_flight" (e.g. a status added later that
 * hasn't been mapped yet).
 */
const STATUS_TO_MESH_ASK: Record<string, MeshAskStatus> = {
  // negotiation.status
  active: "in_flight",
  accepted: "succeeded",
  rejected: "rejected",
  escalated: "escalated",
  // session.status (mesh_ask + blocker rows)
  running: "in_flight",
  completed: "succeeded",
  failed: "blocked",
  // shared
  cancelled: "blocked",
};

const toMeshAskStatus = (raw: string): MeshAskStatus =>
  STATUS_TO_MESH_ASK[raw] ?? "in_flight";

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

export async function getMeshOverview(
  pool: Pool,
  window: MeshWindow = DEFAULT_MESH_WINDOW,
): Promise<MeshOverview> {
  const { negWindow, sessWindow } = buildWindowFragments(window);

  const [negotiationsResult, meshSessionsResult, nodesResult, edgesResult, summaryResult] =
    await Promise.all([
      pool.query<NegotiationsRow>(negotiationsSql(negWindow), [ASKS_LIMIT]),
      pool.query<MeshSessionsRow>(meshSessionsSql(sessWindow), [ASKS_LIMIT]),
      pool.query<NodesRow>(nodesSql(negWindow, sessWindow)),
      pool.query<EdgesRow>(edgesSql(negWindow, sessWindow)),
      pool.query<SummaryRow>(summarySql(negWindow, sessWindow)),
    ]);

  const negotiationAsks: MeshAskData[] = negotiationsResult.rows.map((r) => {
    const status = toMeshAskStatus(r.status);
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
      status: toMeshAskStatus(r.session_status),
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
