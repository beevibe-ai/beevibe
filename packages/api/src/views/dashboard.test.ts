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
import { getDashboardSummary } from "./dashboard.js";

function makePool(responses: unknown[][]) {
  let i = 0;
  const query = vi.fn(async () => ({ rows: responses[i++] ?? [] }));
  return { query: query as unknown as Pool["query"] } as unknown as Pool;
}

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
    const pool = makePool([
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
    const pool = makePool([
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
    const pool = makePool([
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
    const pool = makePool([[], [], makeTrendRows(), [], makeKpiTrendRows()]);
    const { trend, trend_total, trend_change_percent } = await getDashboardSummary(pool);
    expect(trend).toHaveLength(7);
    expect(trend_total).toBe(14); // 7 days × 2
    expect(trend_change_percent).toBe(100); // doubled vs prior
  });

  it("flags is_today on the most recent trend row", async () => {
    const pool = makePool([[], [], makeTrendRows(), [], makeKpiTrendRows()]);
    const { trend } = await getDashboardSummary(pool);
    expect(trend.filter((d) => d.is_today)).toHaveLength(1);
    expect(trend[trend.length - 1]?.is_today).toBe(true);
  });

  it("emits 4 KPIs (active_sessions, in_review, completed_today, blocked) with raw values", async () => {
    const pool = makePool([
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
    const pool = makePool([[], [], makeTrendRows(), [], makeKpiTrendRows()]);
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
    const pool = makePool([[], [], flatTrend, [], makeKpiTrendRows()]);
    const { trend_change_percent } = await getDashboardSummary(pool);
    expect(trend_change_percent).toBe(0);
  });

  it("treats no-prior-period with positive current as 100% change", async () => {
    const trendRows = Array.from({ length: 14 }, (_, i) => ({
      day: `2026-04-${17 + i}`,
      count: i < 7 ? 0 : 3,
    }));
    const pool = makePool([[], [], trendRows, [], makeKpiTrendRows()]);
    const { trend_change_percent } = await getDashboardSummary(pool);
    expect(trend_change_percent).toBe(100);
  });

  it("maps attention rows preserving title, status, and ISO timestamp", async () => {
    const ts = new Date("2026-04-30T10:00:00Z");
    const pool = makePool([
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

  it("fires all 5 queries in parallel (single Promise.all)", async () => {
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
      return { rows: [] };
    });
    const pool = { query } as unknown as Pool;
    await getDashboardSummary(pool);
    expect(calls).toEqual([0, 1, 2, 3, 4]); // dispatched in order, all together
    expect(query).toHaveBeenCalledTimes(5);
  });
});
