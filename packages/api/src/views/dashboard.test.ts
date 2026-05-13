/**
 * Mock-Pool tests for views/dashboard.ts. Validates aggregation logic +
 * row → DTO mapping. Real query correctness exercised by the existing
 * api integration test layer; these stay DB-free.
 *
 * Query order in the implementation:
 *   1) STATUS_COUNT_SQL          → status counts
 *   2) FLEET_SQL                 → per-hier counts + active
 *   3) TREND_SQL                 → 14 days of completed sessions
 *   4) ATTENTION_SQL             → blocked/failed/review tasks
 *   5) KPI_TREND_SQL             → 7 days of per-KPI counts
 */
import { describe, it, expect, vi } from "vitest";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { buildUsageSummary, getDashboardSummary } from "./dashboard.js";
import { makeMockPool } from "./test-helpers.js";

function makeKpiTrendRows(): unknown[] {
  return Array.from({ length: 7 }, (_, i) => ({
    day: `2026-04-${24 + i}`,
    active_sessions: i,
    in_review: 0,
    completed_today: i === 6 ? 5 : 0,
    blocked: 0,
  }));
}

function makeTrendRows(): unknown[] {
  // 14 days: prior 7 = 7×1 = 7 total, recent 7 = 7×2 = 14 total → +100%
  return Array.from({ length: 14 }, (_, i) => ({
    day: `2026-04-${17 + i}`,
    count: i < 7 ? 1 : 2,
  }));
}

describe("getDashboardSummary", () => {
  it("computes percentages from raw status counts and ranks descending", async () => {
    const pool = makeMockPool([
      [
        { status: "in_progress", count: 6 },
        { status: "review", count: 2 },
        { status: "done", count: 2 },
      ],
      [], // fleet
      makeTrendRows(),
      [], // attention
      makeKpiTrendRows(),
    ]);
    const summary = await getDashboardSummary(pool);
    expect(summary.status_total).toBe(10);
    expect(summary.status_breakdown[0]).toEqual({
      status: "in_progress",
      count: 6,
      percent: 60,
    });
    expect(summary.status_breakdown).toHaveLength(3);
  });

  it("buckets statuses into the legend's coarser groups", async () => {
    const pool = makeMockPool([
      [
        { status: "pending", count: 1 },
        { status: "assigned", count: 2 },
        { status: "in_progress", count: 3 },
        { status: "revision", count: 4 },
        { status: "review", count: 5 },
        { status: "blocked", count: 6 },
        { status: "done", count: 7 },
        { status: "failed", count: 8 },
      ],
      [],
      makeTrendRows(),
      [],
      makeKpiTrendRows(),
    ]);
    const { status_legend } = await getDashboardSummary(pool);
    const map = new Map(status_legend.map((l) => [l.bucket, l.count]));
    expect(map.get("pending")).toBe(3); // pending + assigned
    expect(map.get("running")).toBe(7); // in_progress + revision
    expect(map.get("review")).toBe(5);
    expect(map.get("blocked")).toBe(6);
    expect(map.get("done")).toBe(7);
    expect(map.get("failed")).toBe(8);
  });

  it("aggregates fleet counts across hierarchies and computes active total", async () => {
    const pool = makeMockPool([
      [],
      [
        { hier: "org", count: 1, active: 1 },
        { hier: "team", count: 2, active: 1 },
        { hier: "ic", count: 5, active: 0 },
      ],
      makeTrendRows(),
      [],
      makeKpiTrendRows(),
    ]);
    const summary = await getDashboardSummary(pool);
    expect(summary.fleet_total).toBe(8);
    expect(summary.fleet_active).toBe(2);
    expect(summary.fleet_idle).toBe(6);
    expect(summary.fleet[0]?.percent).toBeCloseTo(12.5, 1);
  });

  it("splits the trend window in half and computes the change percent", async () => {
    const pool = makeMockPool([[], [], makeTrendRows(), [], makeKpiTrendRows()]);
    const { trend, trend_total, trend_change_percent } = await getDashboardSummary(pool);
    expect(trend).toHaveLength(7);
    expect(trend_total).toBe(14); // 7 days × 2
    expect(trend_change_percent).toBe(100); // doubled vs prior
  });

  it("flags is_today on the most recent trend row", async () => {
    const pool = makeMockPool([[], [], makeTrendRows(), [], makeKpiTrendRows()]);
    const { trend } = await getDashboardSummary(pool);
    expect(trend.filter((d) => d.is_today)).toHaveLength(1);
    expect(trend[trend.length - 1]?.is_today).toBe(true);
  });

  it("emits 4 KPIs (active_sessions, in_review, completed_today, blocked) with raw values", async () => {
    const pool = makeMockPool([
      [
        { status: "review", count: 4 },
        { status: "blocked", count: 2 },
      ],
      [{ hier: "team", count: 3, active: 2 }],
      makeTrendRows(),
      [],
      makeKpiTrendRows(),
    ]);
    const { kpis } = await getDashboardSummary(pool);
    expect(kpis.map((k) => k.kind)).toEqual([
      "active_sessions",
      "in_review",
      "completed_today",
      "blocked",
    ]);
    expect(kpis.find((k) => k.kind === "active_sessions")?.value).toBe(2); // fleet_active
    expect(kpis.find((k) => k.kind === "in_review")?.value).toBe(4);
    expect(kpis.find((k) => k.kind === "completed_today")?.value).toBe(5); // last day of trend
    expect(kpis.find((k) => k.kind === "blocked")?.value).toBe(2);
  });

  it("handles 0 totals without dividing by zero", async () => {
    const pool = makeMockPool([[], [], makeTrendRows(), [], makeKpiTrendRows()]);
    const { status_total, status_breakdown, fleet_total, fleet } = await getDashboardSummary(pool);
    expect(status_total).toBe(0);
    expect(status_breakdown).toEqual([]);
    expect(fleet_total).toBe(0);
    expect(fleet).toEqual([]);
  });

  it("treats no-prior-period as 0% change when current is also 0", async () => {
    const flatTrend = Array.from({ length: 14 }, (_, i) => ({
      day: `2026-04-${17 + i}`,
      count: 0,
    }));
    const pool = makeMockPool([[], [], flatTrend, [], makeKpiTrendRows()]);
    const { trend_change_percent } = await getDashboardSummary(pool);
    expect(trend_change_percent).toBe(0);
  });

  it("treats no-prior-period with positive current as 100% change", async () => {
    const trendRows = Array.from({ length: 14 }, (_, i) => ({
      day: `2026-04-${17 + i}`,
      count: i < 7 ? 0 : 3,
    }));
    const pool = makeMockPool([[], [], trendRows, [], makeKpiTrendRows()]);
    const { trend_change_percent } = await getDashboardSummary(pool);
    expect(trend_change_percent).toBe(100);
  });

  it("maps attention rows preserving title, status, and ISO timestamp", async () => {
    const ts = new Date("2026-04-30T10:00:00Z");
    const pool = makeMockPool([
      [],
      [],
      makeTrendRows(),
      [{ id: "task_1", title: "needs API key", status: "blocked", created_at: ts }],
      makeKpiTrendRows(),
    ]);
    const { attention } = await getDashboardSummary(pool);
    expect(attention).toHaveLength(1);
    expect(attention[0]).toEqual({
      task_id: "task_1",
      title: "needs API key",
      status: "blocked",
      created_at: ts,
    });
  });

  it("fires all 6 queries in parallel (single Promise.all)", async () => {
    const calls: number[] = [];
    let next = 0;
    const query = vi.fn(async (sql: unknown) => {
      const i = next++;
      calls.push(i);
      // First-issued query resolves last to prove they were issued together,
      // not awaited sequentially.
      await new Promise((r) => setTimeout(r, i === 0 ? 10 : 0));
      const sqlText = String(sql);
      if (sqlText.includes("FROM days") && sqlText.includes("active_sessions")) return { rows: makeKpiTrendRows() };
      if (sqlText.includes("FROM days")) return { rows: makeTrendRows() };
      if (sqlText.includes("FROM agent")) return { rows: [] };
      if (sqlText.includes("blocked', 'failed'")) return { rows: [] };
      if (sqlText.includes("usage IS NOT NULL")) return { rows: [] };
      return { rows: [] };
    });
    const pool = { query } as unknown as Pool;
    await getDashboardSummary(pool);
    expect(calls).toEqual([0, 1, 2, 3, 4, 5]);
    expect(query).toHaveBeenCalledTimes(6);
  });
});

// Helper: build a UsageWindowRow with sensible defaults so test bodies
// stay focused on the field that's actually being exercised.
function row(
  bucket: "current" | "prior",
  overrides: Partial<{
    agent_id: string;
    agent_label: string;
    cost: string;
    input_tokens: string;
    output_tokens: string;
    cache_creation: string;
    cache_read: string;
    sessions: string;
  }> = {},
) {
  return {
    agent_id: "agt_x",
    agent_label: "x",
    bucket,
    cost: "0",
    input_tokens: "0",
    output_tokens: "0",
    cache_creation: "0",
    cache_read: "0",
    sessions: "1",
    ...overrides,
  };
}

describe("buildUsageSummary", () => {
  it("splits rows by bucket: current → totals + per_agent, prior → cost only", () => {
    const summary = buildUsageSummary(
      [
        row("current", {
          agent_id: "agt_alice",
          agent_label: "alice",
          cost: "0.50",
          input_tokens: "100",
          output_tokens: "500",
          cache_creation: "200",
          cache_read: "1700",
          sessions: "5",
        }),
        row("current", {
          agent_id: "agt_bob",
          agent_label: "bob",
          cost: "0.10",
          input_tokens: "10",
          output_tokens: "50",
          cache_read: "100",
        }),
        row("prior", { cost: "0.40" }),
      ],
      7,
    );

    expect(summary.window_days).toBe(7);
    expect(summary.total_cost_usd).toBeCloseTo(0.6, 5);
    expect(summary.total_input_tokens).toBe(110);
    expect(summary.total_output_tokens).toBe(550);
    expect(summary.total_cache_creation_tokens).toBe(200);
    expect(summary.total_cache_read_tokens).toBe(1800);
    expect(summary.total_sessions).toBe(6);
    expect(summary.prior_cost_usd).toBeCloseTo(0.4, 5);
    expect(summary.per_agent).toHaveLength(2);
    // SQL pre-sorts current by cost desc; the builder preserves order.
    expect(summary.per_agent[0]!.agent_label).toBe("alice");
    expect(summary.per_agent[0]!.cost_usd).toBeCloseTo(0.5, 5);
  });

  it("sums multiple prior rows into prior_cost_usd", () => {
    // Prior can span multiple agents — the SQL groups by (agent, bucket).
    const summary = buildUsageSummary(
      [row("prior", { cost: "0.30" }), row("prior", { cost: "0.10" })],
      7,
    );
    expect(summary.prior_cost_usd).toBeCloseTo(0.4, 5);
  });

  it("computes cache_hit_ratio against total_input via the shared helper", () => {
    // 1700 cache_read / (100 + 200 + 1700) = 0.85
    const summary = buildUsageSummary(
      [
        row("current", {
          input_tokens: "100",
          output_tokens: "50",
          cache_creation: "200",
          cache_read: "1700",
        }),
      ],
      7,
    );
    expect(summary.cache_hit_ratio).toBeCloseTo(0.85, 5);
  });

  it("guards cache_hit_ratio against divide-by-zero (no input in window)", () => {
    const summary = buildUsageSummary([], 7);
    expect(summary.cache_hit_ratio).toBe(0);
    expect(Number.isFinite(summary.cache_hit_ratio)).toBe(true);
  });

  it("computes cost_change_percent vs prior window (rounded int, both directions)", () => {
    const up = buildUsageSummary(
      [row("current", { cost: "1.50" }), row("prior", { cost: "1.00" })],
      7,
    );
    expect(up.cost_change_percent).toBe(50);

    const down = buildUsageSummary(
      [row("current", { cost: "0.50" }), row("prior", { cost: "1.00" })],
      7,
    );
    expect(down.cost_change_percent).toBe(-50);
  });

  it("saturates cost_change_percent at +100 when prior was zero and current is non-zero", () => {
    const summary = buildUsageSummary([row("current", { cost: "0.05" })], 7);
    expect(summary.cost_change_percent).toBe(100);
  });

  it("returns cost_change_percent = 0 when both windows are zero", () => {
    const summary = buildUsageSummary([], 7);
    expect(summary.cost_change_percent).toBe(0);
  });

  it("handles a row set with only prior bucket (no current sessions)", () => {
    const summary = buildUsageSummary([row("prior", { cost: "0.50" })], 7);
    expect(summary.prior_cost_usd).toBeCloseTo(0.5, 5);
    expect(summary.total_cost_usd).toBe(0);
    expect(summary.per_agent).toEqual([]);
    expect(summary.cost_change_percent).toBe(-100); // 0.50 → 0 prior→current
  });
});
