/**
 * Memory-activity view — Layer A telemetry for the /memory/eval dashboard.
 *
 * Six parallel queries that surface "what got written, by whom, when, of
 * what type" plus an optional before/after split. Activity-level signal —
 * not a quality metric. Mirrors the queries in `scripts/memory-activity-
 * report.ts` (the developer-side ad-hoc tool); this view is the dashboard
 * surface for the same data.
 *
 * Known limitation: core_memory_block has no write event log, only
 * `updated_at` on the current row. `core_snapshot` and `core_touched_30d`
 * use snapshot proxies that undercount churn (a block updated 5× in 30d
 * shows as 1). A follow-up trigger-backed event table would close that gap.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type {
  AgentRatioRow,
  AgentActivityRow,
  BeforeAfterData,
  CoreSnapshotRow,
  DormantAgentRow,
  MemoryActivitySummary,
  MemoryActivityKpis,
  ScopeTypeRow,
  WeeklyArchivalRow,
} from "./types.js";

export interface MemoryActivityOptions {
  /** Window for weekly trend + scope×type breakdown. Clamped 1..52. */
  weeks: number;
  /** ISO date for before/after split. When absent, before_after is omitted. */
  since?: string;
}

export async function getMemoryActivity(
  pool: Pool,
  opts: MemoryActivityOptions,
): Promise<MemoryActivitySummary> {
  const weeks = clampInt(opts.weeks, 1, 52, 12);
  const weeksInterval = `${weeks} weeks`;

  const [
    weekly,
    byScopeType,
    topAgents,
    dormant,
    coreSnapshot,
    ratio,
    kpis,
    beforeAfter,
  ] = await Promise.all([
    queryWeeklyArchival(pool, weeksInterval),
    queryScopeTypeBreakdown(pool, weeksInterval),
    queryTopAgents(pool),
    queryDormantAgents(pool),
    queryCoreSnapshot(pool),
    queryArchivalToCoreRatio(pool),
    queryKpis(pool),
    opts.since ? queryBeforeAfter(pool, opts.since) : Promise.resolve(undefined),
  ]);

  return {
    weeks,
    since: opts.since ?? null,
    kpis,
    weekly_archival: weekly,
    by_scope_and_type: byScopeType,
    top_agents: topAgents,
    dormant_agents: dormant,
    core_snapshot: coreSnapshot,
    archival_to_core_per_agent: ratio,
    before_after: beforeAfter,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────

interface WeeklyRow {
  week: Date;
  total: string;
  belief: string;
  pattern: string;
  gotcha: string;
  preference: string;
  decision: string;
  active_agents: string;
}

async function queryWeeklyArchival(
  pool: Pool,
  interval: string,
): Promise<WeeklyArchivalRow[]> {
  const { rows } = await pool.query<WeeklyRow>(
    `SELECT date_trunc('week', created_at AT TIME ZONE 'UTC')::date AS week,
            COUNT(*)                                                AS total,
            COUNT(*) FILTER (WHERE fact_type = 'belief')            AS belief,
            COUNT(*) FILTER (WHERE fact_type = 'pattern')           AS pattern,
            COUNT(*) FILTER (WHERE fact_type = 'gotcha')            AS gotcha,
            COUNT(*) FILTER (WHERE fact_type = 'preference')        AS preference,
            COUNT(*) FILTER (WHERE fact_type = 'decision')          AS decision,
            COUNT(DISTINCT agent_id)                                AS active_agents
       FROM memory_fact
      WHERE created_at >= NOW() - $1::interval
   GROUP BY week
   ORDER BY week ASC`,
    [interval],
  );
  return rows.map((r) => ({
    week: localDate(r.week),
    total: Number(r.total),
    belief: Number(r.belief),
    pattern: Number(r.pattern),
    gotcha: Number(r.gotcha),
    preference: Number(r.preference),
    decision: Number(r.decision),
    active_agents: Number(r.active_agents),
  }));
}

interface ScopeTypeQueryRow {
  scope: "ic" | "team" | "org";
  fact_type: string;
  writes: string;
}

async function queryScopeTypeBreakdown(
  pool: Pool,
  interval: string,
): Promise<ScopeTypeRow[]> {
  const { rows } = await pool.query<ScopeTypeQueryRow>(
    `SELECT scope, fact_type, COUNT(*) AS writes
       FROM memory_fact
      WHERE created_at >= NOW() - $1::interval
   GROUP BY scope, fact_type
   ORDER BY scope, writes DESC`,
    [interval],
  );
  return rows.map((r) => ({
    scope: r.scope,
    fact_type: r.fact_type,
    writes: Number(r.writes),
  }));
}

interface AgentRow {
  id: string;
  name: string;
  tier: string;
  writes_30d: string;
  type_variety: string;
  last_write: Date;
}

async function queryTopAgents(pool: Pool): Promise<AgentActivityRow[]> {
  const { rows } = await pool.query<AgentRow>(
    `SELECT a.id, a.name, a.hierarchy_level                  AS tier,
            COUNT(mf.id)                                     AS writes_30d,
            COUNT(DISTINCT mf.fact_type)                     AS type_variety,
            MAX(mf.created_at)::date                         AS last_write
       FROM agent a
       JOIN memory_fact mf
              ON mf.agent_id = a.id
             AND mf.created_at >= NOW() - INTERVAL '30 days'
   GROUP BY a.id, a.name, a.hierarchy_level
   ORDER BY writes_30d DESC
      LIMIT 20`,
  );
  return rows.map((r) => ({
    agent_id: r.id,
    name: r.name,
    tier: r.tier,
    writes_30d: Number(r.writes_30d),
    type_variety: Number(r.type_variety),
    last_write: localDate(r.last_write),
  }));
}

interface DormantRow {
  id: string;
  name: string;
  tier: string;
  last_write_ever: Date | null;
  agent_created: Date;
}

async function queryDormantAgents(pool: Pool): Promise<DormantAgentRow[]> {
  const { rows } = await pool.query<DormantRow>(
    `SELECT a.id, a.name, a.hierarchy_level                  AS tier,
            (SELECT MAX(created_at)::date FROM memory_fact
              WHERE agent_id = a.id)                         AS last_write_ever,
            a.created_at::date                               AS agent_created
       FROM agent a
      WHERE NOT EXISTS (
              SELECT 1 FROM memory_fact mf
               WHERE mf.agent_id = a.id
                 AND mf.created_at > NOW() - INTERVAL '30 days')
   ORDER BY a.created_at DESC
      LIMIT 20`,
  );
  return rows.map((r) => ({
    agent_id: r.id,
    name: r.name,
    tier: r.tier,
    last_write_ever: r.last_write_ever ? localDate(r.last_write_ever) : null,
    agent_created: localDate(r.agent_created),
  }));
}

interface CoreRow {
  tier: string;
  block_name: string;
  blocks: string;
  non_empty: string;
  ever_updated: string;
  updated_30d: string;
  avg_chars: string | null;
}

async function queryCoreSnapshot(pool: Pool): Promise<CoreSnapshotRow[]> {
  const { rows } = await pool.query<CoreRow>(
    `SELECT a.hierarchy_level                                         AS tier,
            cmb.block_name,
            COUNT(*)                                                  AS blocks,
            COUNT(*) FILTER (WHERE LENGTH(cmb.content) > 0)           AS non_empty,
            COUNT(*) FILTER (WHERE cmb.updated_at > cmb.created_at)   AS ever_updated,
            COUNT(*) FILTER (WHERE cmb.updated_at > NOW() - INTERVAL '30 days'
                                AND cmb.updated_at > cmb.created_at)  AS updated_30d,
            ROUND(AVG(LENGTH(cmb.content)))                           AS avg_chars
       FROM core_memory_block cmb
       JOIN agent a ON a.id = cmb.agent_id
   GROUP BY a.hierarchy_level, cmb.block_name
   ORDER BY a.hierarchy_level, cmb.block_name`,
  );
  return rows.map((r) => ({
    tier: r.tier,
    block_name: r.block_name,
    blocks: Number(r.blocks),
    non_empty: Number(r.non_empty),
    ever_updated: Number(r.ever_updated),
    updated_30d: Number(r.updated_30d),
    avg_chars: r.avg_chars === null ? 0 : Number(r.avg_chars),
  }));
}

interface RatioRow {
  id: string;
  name: string;
  tier: string;
  archival_30d: string;
  core_touched_30d: string;
}

async function queryArchivalToCoreRatio(pool: Pool): Promise<AgentRatioRow[]> {
  const { rows } = await pool.query<RatioRow>(
    `SELECT a.id, a.name, a.hierarchy_level                  AS tier,
            arch.cnt                                         AS archival_30d,
            core.cnt                                         AS core_touched_30d
       FROM agent a
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt FROM memory_fact
          WHERE agent_id = a.id AND created_at > NOW() - INTERVAL '30 days'
       ) arch ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt FROM core_memory_block
          WHERE agent_id = a.id
            AND updated_at > NOW() - INTERVAL '30 days'
            AND updated_at > created_at
       ) core ON TRUE
      WHERE arch.cnt > 0 OR core.cnt > 0
   ORDER BY arch.cnt DESC
      LIMIT 25`,
  );
  return rows.map((r) => {
    const archival = Number(r.archival_30d);
    const core = Number(r.core_touched_30d);
    return {
      agent_id: r.id,
      name: r.name,
      tier: r.tier,
      archival_30d: archival,
      core_touched_30d: core,
      // null when no core touches — caller renders as "—" rather than ∞.
      ratio: core > 0 ? Math.round((archival / core) * 10) / 10 : null,
    };
  });
}

interface KpiRow {
  archival_writes_30d: string;
  core_touched_30d: string;
  active_agents_30d: string;
}

async function queryKpis(pool: Pool): Promise<MemoryActivityKpis> {
  const { rows } = await pool.query<KpiRow>(
    `SELECT
       (SELECT COUNT(*) FROM memory_fact
         WHERE created_at > NOW() - INTERVAL '30 days')        AS archival_writes_30d,
       (SELECT COUNT(*) FROM core_memory_block
         WHERE updated_at > NOW() - INTERVAL '30 days'
           AND updated_at > created_at)                         AS core_touched_30d,
       (SELECT COUNT(DISTINCT agent_id) FROM memory_fact
         WHERE created_at > NOW() - INTERVAL '30 days')        AS active_agents_30d`,
  );
  const r = rows[0]!;
  const archival = Number(r.archival_writes_30d);
  const core = Number(r.core_touched_30d);
  return {
    archival_writes_30d: archival,
    core_touched_30d: core,
    active_agents_30d: Number(r.active_agents_30d),
    archival_to_core_ratio:
      core > 0 ? Math.round((archival / core) * 10) / 10 : null,
  };
}

interface BeforeAfterTypeRow {
  fact_type: string;
  pre: string;
  post: string;
  pre_pct: string | null;
  post_pct: string | null;
}

interface BeforeAfterAggRow {
  agents_pre: string;
  agents_post: string;
  writes_pre: string;
  writes_post: string;
}

async function queryBeforeAfter(
  pool: Pool,
  since: string,
): Promise<BeforeAfterData> {
  const [byType, agg] = await Promise.all([
    pool.query<BeforeAfterTypeRow>(
      `WITH win AS (
         SELECT * FROM memory_fact
          WHERE created_at >= $1::timestamptz - INTERVAL '14 days'
            AND created_at  < $1::timestamptz + INTERVAL '14 days'
       ),
       totals AS (
         SELECT
           COUNT(*) FILTER (WHERE created_at <  $1::timestamptz) AS pre_total,
           COUNT(*) FILTER (WHERE created_at >= $1::timestamptz) AS post_total
           FROM win
       )
       SELECT
         fact_type,
         COUNT(*) FILTER (WHERE created_at <  $1::timestamptz)  AS pre,
         COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)  AS post,
         ROUND(100.0 * COUNT(*) FILTER (WHERE created_at <  $1::timestamptz)
               / NULLIF((SELECT pre_total  FROM totals), 0), 1) AS pre_pct,
         ROUND(100.0 * COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)
               / NULLIF((SELECT post_total FROM totals), 0), 1) AS post_pct
         FROM win
     GROUP BY fact_type
     ORDER BY fact_type`,
      [since],
    ),
    pool.query<BeforeAfterAggRow>(
      `WITH win AS (
         SELECT * FROM memory_fact
          WHERE created_at >= $1::timestamptz - INTERVAL '14 days'
            AND created_at  < $1::timestamptz + INTERVAL '14 days'
       )
       SELECT
         COUNT(DISTINCT agent_id) FILTER (WHERE created_at <  $1::timestamptz) AS agents_pre,
         COUNT(DISTINCT agent_id) FILTER (WHERE created_at >= $1::timestamptz) AS agents_post,
         COUNT(*) FILTER (WHERE created_at <  $1::timestamptz)                 AS writes_pre,
         COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)                 AS writes_post
         FROM win`,
      [since],
    ),
  ]);

  const a = agg.rows[0]!;
  return {
    since,
    by_type: byType.rows.map((r) => ({
      fact_type: r.fact_type,
      pre: Number(r.pre),
      post: Number(r.post),
      pre_pct: r.pre_pct === null ? null : Number(r.pre_pct),
      post_pct: r.post_pct === null ? null : Number(r.post_pct),
    })),
    agg: {
      agents_pre: Number(a.agents_pre),
      agents_post: Number(a.agents_post),
      writes_pre: Number(a.writes_pre),
      writes_post: Number(a.writes_post),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value) || value < min) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/**
 * node-postgres parses `::date` columns as JS Date at LOCAL midnight, so
 * `.toISOString()` (UTC) would shift the day by the local offset. Read the
 * local components and emit "YYYY-MM-DD".
 */
function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
