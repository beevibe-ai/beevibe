/**
 * Dashboard view — pure data composer for the home page. Returns counts,
 * percents, and raw IDs/timestamps. Display fields (colors, hrefs, day
 * labels, "5m ago" age) are computed web-side via `lib/dashboard-display.ts`.
 *
 * One round-trip: 5 queries fired in parallel. None depends on the others.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { HierarchyLevel, TaskStatus } from "@beevibe/core";
import type {
  DashboardSummary,
  KpiData,
  StatusBreakdownData,
  StatusLegendData,
  FleetBarData,
  TrendDayData,
  AttentionData,
  LegendBucket,
  UsageAgentBreakdown,
  UsageSummaryData,
} from "./types.js";

interface StatusCountRow {
  status: TaskStatus;
  count: string;
}

interface FleetCountRow {
  hier: HierarchyLevel;
  count: string;
  active: string;
}

interface TrendRow {
  day: string;
  count: string;
}

interface AttentionRow {
  id: string;
  title: string;
  status: "blocked" | "failed" | "review";
  created_at: Date;
}

interface KpiTrendRow {
  day: string;
  active_sessions: string;
  in_review: string;
  completed_today: string;
  blocked: string;
}

/**
 * Per-agent row from the current-window usage aggregate. All numeric
 * fields are numeric strings from pg (driver doesn't coerce SUM /
 * COUNT to JS Number to preserve precision for large values); the
 * builder converts them with Number(...).
 */
interface UsageAgentRow {
  agent_id: string;
  agent_label: string;
  cost: string;
  input_tokens: string;
  output_tokens: string;
  cache_creation: string;
  cache_read: string;
  sessions: string;
}

interface UsagePriorRow {
  prior_cost: string;
}

const STATUS_COUNT_SQL = /* sql */ `
SELECT status, COUNT(*)::int AS count
FROM task
GROUP BY status
`;

const FLEET_SQL = /* sql */ `
WITH active_agents AS (
  SELECT DISTINCT agent_id FROM session WHERE status = 'running'
)
SELECT
  a.hierarchy_level AS hier,
  COUNT(*)::int     AS count,
  COUNT(*) FILTER (WHERE aa.agent_id IS NOT NULL)::int AS active
FROM agent a
LEFT JOIN active_agents aa ON aa.agent_id = a.id
GROUP BY a.hierarchy_level
`;

const TREND_SQL = /* sql */ `
WITH days AS (
  SELECT (CURRENT_DATE - i)::date AS d
  FROM generate_series(0, $1 - 1) AS i
),
session_counts AS (
  SELECT (completed_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
  FROM session
  WHERE status = 'succeeded'
    AND completed_at >= CURRENT_DATE - $1::int
  GROUP BY day
)
SELECT
  to_char(days.d, 'YYYY-MM-DD') AS day,
  COALESCE(sc.n, 0)::int        AS count
FROM days
LEFT JOIN session_counts sc ON sc.day = days.d
ORDER BY days.d ASC
`;

const ATTENTION_SQL = /* sql */ `
SELECT id, title, status, updated_at AS created_at
FROM task
WHERE status IN ('blocked', 'failed', 'review')
ORDER BY updated_at DESC
LIMIT $1
`;

const KPI_TREND_SQL = /* sql */ `
WITH days AS (
  SELECT (CURRENT_DATE - i)::date AS d
  FROM generate_series(0, $1 - 1) AS i
),
sessions_per_day AS (
  SELECT (started_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
  FROM session
  WHERE started_at >= CURRENT_DATE - $1::int
  GROUP BY day
),
review_per_day AS (
  SELECT (updated_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
  FROM task
  WHERE status = 'review'
    AND updated_at >= CURRENT_DATE - $1::int
  GROUP BY day
),
done_per_day AS (
  SELECT (updated_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
  FROM task
  WHERE status = 'done'
    AND updated_at >= CURRENT_DATE - $1::int
  GROUP BY day
),
blocked_per_day AS (
  SELECT (updated_at AT TIME ZONE 'UTC')::date AS day, COUNT(*)::int AS n
  FROM task
  WHERE status = 'blocked'
    AND updated_at >= CURRENT_DATE - $1::int
  GROUP BY day
)
SELECT
  to_char(days.d, 'YYYY-MM-DD')      AS day,
  COALESCE(s.n, 0)::int              AS active_sessions,
  COALESCE(r.n, 0)::int              AS in_review,
  COALESCE(c.n, 0)::int              AS completed_today,
  COALESCE(b.n, 0)::int              AS blocked
FROM days
LEFT JOIN sessions_per_day s ON s.day = days.d
LEFT JOIN review_per_day   r ON r.day = days.d
LEFT JOIN done_per_day     c ON c.day = days.d
LEFT JOIN blocked_per_day  b ON b.day = days.d
ORDER BY days.d ASC
`;

/**
 * Per-agent cost + token rollup for the current usage window. Filters
 * out rows where `usage` is null (older sessions captured before M9.8
 * have no usage record) so they don't contribute zero rows that
 * dilute the per-agent ordering.
 *
 * Window length comes from $1 as days. Driver passes interval via
 * `make_interval` so we don't string-concatenate (parameterized).
 *
 * `cost` is cast to `numeric` to preserve cent-level precision; the
 * driver returns it as a string and the builder converts with
 * `Number()` (safe for sub-million-dollar totals).
 */
const USAGE_CURRENT_SQL = /* sql */ `
SELECT
  s.agent_id,
  a.name AS agent_label,
  COALESCE(SUM((s.usage->>'cost_usd')::numeric), 0)::text AS cost,
  COALESCE(SUM((s.usage->>'input_tokens')::int), 0)::text AS input_tokens,
  COALESCE(SUM((s.usage->>'output_tokens')::int), 0)::text AS output_tokens,
  COALESCE(SUM((s.usage->>'cache_creation_input_tokens')::int), 0)::text AS cache_creation,
  COALESCE(SUM((s.usage->>'cache_read_input_tokens')::int), 0)::text AS cache_read,
  COUNT(*)::text AS sessions
FROM session s
JOIN agent a ON a.id = s.agent_id
WHERE s.usage IS NOT NULL
  AND s.completed_at >= NOW() - make_interval(days => $1::int)
GROUP BY s.agent_id, a.name
ORDER BY SUM((s.usage->>'cost_usd')::numeric) DESC NULLS LAST
`;

/**
 * Prior-window total cost only, used for the cost_change_percent
 * delta. No per-agent breakdown needed for prior — the UI only shows
 * the top-line "vs prior" arrow, not "agent X spent more last week."
 *
 * Prior window = [now - 2*days, now - days), an equally-sized window
 * immediately preceding the current one.
 */
const USAGE_PRIOR_SQL = /* sql */ `
SELECT
  COALESCE(SUM((s.usage->>'cost_usd')::numeric), 0)::text AS prior_cost
FROM session s
WHERE s.usage IS NOT NULL
  AND s.completed_at >= NOW() - make_interval(days => $1::int * 2)
  AND s.completed_at <  NOW() - make_interval(days => $1::int)
`;

const TREND_WINDOW_DAYS = 7;
const ATTENTION_LIMIT = 8;

/** Map raw task status to the legend's coarser bucket. */
function legendBucket(status: TaskStatus): LegendBucket {
  switch (status) {
    case "in_progress":
    case "revision":
      return "running";
    case "review":
      return "review";
    case "blocked":
      return "blocked";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "pending":
    case "assigned":
    case "needs_revision":
    case "cancelled":
      return "pending";
  }
}

export async function getDashboardSummary(pool: Pool): Promise<DashboardSummary> {
  const [
    statusResult,
    fleetResult,
    trendResult,
    attentionResult,
    kpiTrendResult,
    usageCurrentResult,
    usagePriorResult,
  ] = await Promise.all([
    pool.query<StatusCountRow>(STATUS_COUNT_SQL),
    pool.query<FleetCountRow>(FLEET_SQL),
    pool.query<TrendRow>(TREND_SQL, [TREND_WINDOW_DAYS * 2]),
    pool.query<AttentionRow>(ATTENTION_SQL, [ATTENTION_LIMIT]),
    pool.query<KpiTrendRow>(KPI_TREND_SQL, [TREND_WINDOW_DAYS]),
    pool.query<UsageAgentRow>(USAGE_CURRENT_SQL, [TREND_WINDOW_DAYS]),
    pool.query<UsagePriorRow>(USAGE_PRIOR_SQL, [TREND_WINDOW_DAYS]),
  ]);

  const status_total = statusResult.rows.reduce((s, r) => s + Number(r.count), 0);
  const status_breakdown: StatusBreakdownData[] = statusResult.rows
    .map((r) => ({
      status: r.status,
      count: Number(r.count),
      percent: status_total === 0 ? 0 : (Number(r.count) / status_total) * 100,
    }))
    .sort((a, b) => b.count - a.count);

  const legendBuckets = new Map<LegendBucket, number>();
  for (const r of statusResult.rows) {
    const b = legendBucket(r.status);
    legendBuckets.set(b, (legendBuckets.get(b) ?? 0) + Number(r.count));
  }
  const status_legend: StatusLegendData[] = Array.from(legendBuckets.entries()).map(
    ([bucket, count]) => ({ bucket, count }),
  );

  const fleet_total = fleetResult.rows.reduce((s, r) => s + Number(r.count), 0);
  const fleet_active = fleetResult.rows.reduce((s, r) => s + Number(r.active), 0);
  const fleet: FleetBarData[] = fleetResult.rows.map((r) => ({
    hier: r.hier,
    count: Number(r.count),
    percent: fleet_total === 0 ? 0 : (Number(r.count) / fleet_total) * 100,
  }));

  // Trend window of 14 days: split into prior 7 and current 7 to compute the
  // "+12% vs prior" delta. Backend produces both numbers; web picks the format.
  const all = trendResult.rows.map((r) => ({ day: r.day, value: Number(r.count) }));
  const recent = all.slice(-TREND_WINDOW_DAYS);
  const prior = all.slice(0, TREND_WINDOW_DAYS);
  const today = recent[recent.length - 1]?.day;
  const trend: TrendDayData[] = recent.map((r) => ({
    date: r.day,
    value: r.value,
    is_today: r.day === today,
  }));
  const trend_total = recent.reduce((s, r) => s + r.value, 0);
  const priorTotal = prior.reduce((s, r) => s + r.value, 0);
  const trend_change_percent =
    priorTotal === 0
      ? trend_total === 0
        ? 0
        : 100
      : Math.round(((trend_total - priorTotal) / priorTotal) * 100);

  const attention: AttentionData[] = attentionResult.rows.map((r) => ({
    task_id: r.id,
    title: r.title,
    status: r.status,
    created_at: r.created_at,
  }));

  const kpis: KpiData[] = buildKpis(kpiTrendResult.rows, statusResult.rows, fleet_active);

  const usage_summary: UsageSummaryData = buildUsageSummary(
    usageCurrentResult.rows,
    usagePriorResult.rows,
    TREND_WINDOW_DAYS,
  );

  return {
    kpis,
    status_breakdown,
    status_legend,
    status_total,
    fleet,
    fleet_total,
    fleet_active,
    fleet_idle: fleet_total - fleet_active,
    trend,
    trend_total,
    trend_change_percent,
    attention,
    usage_summary,
  };
}

function buildKpis(
  kpiRows: KpiTrendRow[],
  statusRows: StatusCountRow[],
  activeAgents: number,
): KpiData[] {
  const statusMap = new Map<TaskStatus, number>();
  for (const r of statusRows) statusMap.set(r.status, Number(r.count));

  const last = (key: keyof Omit<KpiTrendRow, "day">): number =>
    kpiRows.length > 0 ? Number(kpiRows[kpiRows.length - 1]![key]) : 0;
  const trend = (key: keyof Omit<KpiTrendRow, "day">): number[] =>
    kpiRows.map((r) => Number(r[key]));

  return [
    {
      kind: "active_sessions",
      value: activeAgents,
      unit: "running",
      trend: trend("active_sessions"),
    },
    {
      kind: "in_review",
      value: statusMap.get("review") ?? 0,
      trend: trend("in_review"),
    },
    {
      kind: "completed_today",
      value: last("completed_today"),
      unit: "today",
      trend: trend("completed_today"),
    },
    {
      kind: "blocked",
      value: statusMap.get("blocked") ?? 0,
      trend: trend("blocked"),
    },
  ];
}

/**
 * Aggregate the per-agent + prior-window rows into the wire-shape
 * UsageSummaryData. Pure function so the SQL stays narrow and the
 * shape contract is testable without a database.
 *
 * Delta semantics match the trend block above:
 *   - prior > 0  → round((current - prior) / prior * 100)
 *   - prior == 0 and current > 0 → +100 (saturate, don't divide by 0)
 *   - prior == 0 and current == 0 → 0 (no signal)
 *
 * Weighted cache_hit_ratio: total_cache_read / total_input across the
 * whole window. NOT a simple mean of per-session ratios — those would
 * over-weight tiny sessions. Zero when total_input is zero.
 */
export function buildUsageSummary(
  currentRows: UsageAgentRow[],
  priorRows: UsagePriorRow[],
  windowDays: number,
): UsageSummaryData {
  let total_cost_usd = 0;
  let total_input_tokens = 0;
  let total_output_tokens = 0;
  let total_cache_creation_tokens = 0;
  let total_cache_read_tokens = 0;
  let total_sessions = 0;
  const per_agent: UsageAgentBreakdown[] = [];

  for (const r of currentRows) {
    const cost = Number(r.cost);
    const input = Number(r.input_tokens);
    const output = Number(r.output_tokens);
    const cacheCreation = Number(r.cache_creation);
    const cacheRead = Number(r.cache_read);
    const sessions = Number(r.sessions);
    total_cost_usd += cost;
    total_input_tokens += input;
    total_output_tokens += output;
    total_cache_creation_tokens += cacheCreation;
    total_cache_read_tokens += cacheRead;
    total_sessions += sessions;
    per_agent.push({
      agent_id: r.agent_id,
      agent_label: r.agent_label,
      cost_usd: cost,
      sessions,
    });
  }

  // total_input_tokens is the union of fresh + cache_creation + cache_read
  // (the same denominator used in SessionUsageDisplay). Without summing
  // all three, we'd compute cache_hit_ratio against only the fresh slice.
  const total_input_for_ratio =
    total_input_tokens + total_cache_creation_tokens + total_cache_read_tokens;
  const cache_hit_ratio =
    total_input_for_ratio > 0
      ? total_cache_read_tokens / total_input_for_ratio
      : 0;

  const prior_cost_usd = Number(priorRows[0]?.prior_cost ?? 0);
  const cost_change_percent =
    prior_cost_usd === 0
      ? total_cost_usd === 0
        ? 0
        : 100
      : Math.round(
          ((total_cost_usd - prior_cost_usd) / prior_cost_usd) * 100,
        );

  return {
    window_days: windowDays,
    total_cost_usd,
    prior_cost_usd,
    cost_change_percent,
    total_input_tokens,
    total_output_tokens,
    total_cache_creation_tokens,
    total_cache_read_tokens,
    cache_hit_ratio,
    total_sessions,
    per_agent,
  };
}
