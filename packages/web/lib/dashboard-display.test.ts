/**
 * Tests for `summaryToDisplay` — the data → display mapper that keeps the
 * backend's pure-data DashboardSummary uncoupled from the web's URL
 * structure, color enums, and labelling choices.
 */
import { describe, it, expect } from "vitest";
import { summaryToDisplay } from "./dashboard-display";
import type { DashboardSummary } from "@/lib/types/dashboard";

function emptyData(): DashboardSummary {
  return {
    kpis: [],
    status_breakdown: [],
    status_legend: [],
    status_total: 0,
    fleet: [],
    fleet_total: 0,
    fleet_active: 0,
    fleet_idle: 0,
    trend: [],
    trend_total: 0,
    trend_change_percent: 0,
    attention: [],
    usage_summary: {
      window_days: 7,
      total_cost_usd: 0,
      prior_cost_usd: 0,
      cost_change_percent: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_creation_tokens: 0,
      total_cache_read_tokens: 0,
      cache_hit_ratio: 0,
      total_sessions: 0,
      per_agent: [],
    },
  };
}

describe("summaryToDisplay — KPIs", () => {
  it("maps each KPI kind to a stable label + href + color + chart kind", () => {
    const data: DashboardSummary = {
      ...emptyData(),
      kpis: [
        { kind: "active_sessions", value: 5, unit: "running", trend: [1, 2, 3] },
        { kind: "in_review", value: 2, trend: [0, 1, 0] },
        { kind: "completed_today", value: 8, unit: "today", trend: [3, 5, 8] },
        { kind: "blocked", value: 1, trend: [0, 0, 1] },
      ],
    };
    const display = summaryToDisplay(data);
    const byKpi = (label: string) => display.kpis.find((k) => k.label === label)!;

    expect(byKpi("Active sessions").trend_color).toBe("running");
    expect(byKpi("Active sessions").trend_kind).toBe("line");
    expect(byKpi("Active sessions").href).toBe("/tasks?lifecycle=in_progress");
    expect(byKpi("Active sessions").value).toBe("5");
    expect(byKpi("Active sessions").unit).toBe("running");

    expect(byKpi("Awaiting review").trend_color).toBe("review");
    expect(byKpi("Awaiting review").trend_kind).toBe("bar");
    expect(byKpi("Completed today").trend_color).toBe("done");
    expect(byKpi("Blocked").trend_color).toBe("primary");
  });

  it("preserves raw trend arrays (web's sparkline owns geometry)", () => {
    const data: DashboardSummary = {
      ...emptyData(),
      kpis: [{ kind: "active_sessions", value: 0, trend: [1, 2, 3, 4, 5, 6, 7] }],
    };
    expect(summaryToDisplay(data).kpis[0]?.trend).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("summaryToDisplay — status breakdown + legend", () => {
  it("attaches deterministic label + color from the status enum", () => {
    const data: DashboardSummary = {
      ...emptyData(),
      status_breakdown: [
        { status: "in_progress", count: 5, percent: 50 },
        { status: "review", count: 3, percent: 30 },
        { status: "blocked", count: 2, percent: 20 },
      ],
    };
    const { status_breakdown } = summaryToDisplay(data);
    expect(status_breakdown[0]).toEqual({
      status: "in_progress",
      label: "In progress",
      color: "running",
      count: 5,
      percent: 50,
    });
    expect(status_breakdown[1]?.color).toBe("review");
    expect(status_breakdown[2]?.color).toBe("blocked");
  });

  it("maps cancelled to the pending color (de-emphasized terminal state)", () => {
    const data: DashboardSummary = {
      ...emptyData(),
      status_breakdown: [{ status: "cancelled", count: 1, percent: 100 }],
    };
    expect(summaryToDisplay(data).status_breakdown[0]?.color).toBe("pending");
  });

  it("legend uses the bucket as the color and humanizes the label", () => {
    const data: DashboardSummary = {
      ...emptyData(),
      status_legend: [
        { bucket: "running", count: 7 },
        { bucket: "blocked", count: 2 },
      ],
    };
    expect(summaryToDisplay(data).status_legend).toEqual([
      { color: "running", label: "Running", count: 7 },
      { color: "blocked", label: "Blocked", count: 2 },
    ]);
  });
});

describe("summaryToDisplay — fleet + scalars passthrough", () => {
  it("forwards fleet bars + scalar totals untouched", () => {
    const data: DashboardSummary = {
      ...emptyData(),
      fleet: [
        { hier: "org", count: 1, percent: 10 },
        { hier: "team", count: 4, percent: 40 },
      ],
      fleet_total: 5,
      fleet_active: 3,
      fleet_idle: 2,
      status_total: 12,
      trend_total: 50,
      trend_change_percent: 25,
    };
    const display = summaryToDisplay(data);
    expect(display.fleet).toEqual(data.fleet);
    expect(display.fleet_total).toBe(5);
    expect(display.fleet_active).toBe(3);
    expect(display.fleet_idle).toBe(2);
    expect(display.status_total).toBe(12);
    expect(display.trend_total).toBe(50);
    expect(display.trend_change_percent).toBe(25);
  });
});

describe("summaryToDisplay — trend day labels", () => {
  it("derives the short weekday label from the ISO date", () => {
    const data: DashboardSummary = {
      ...emptyData(),
      trend: [
        { date: "2026-04-27", value: 3, is_today: false }, // Monday
        { date: "2026-04-30", value: 5, is_today: true }, // Thursday
      ],
    };
    const labels = summaryToDisplay(data).trend.map((d) => d.label);
    expect(labels).toEqual(["Mon", "Thu"]);
    expect(summaryToDisplay(data).trend[1]?.is_today).toBe(true);
  });
});

describe("summaryToDisplay — attention", () => {
  it("builds task hrefs and formats relative age from created_at", () => {
    const recent = new Date(Date.now() - 5 * 60_000);
    const data: DashboardSummary = {
      ...emptyData(),
      attention: [
        {
          task_id: "task_xyz",
          title: "needs API key",
          status: "blocked",
          created_at: recent,
        },
      ],
    };
    const display = summaryToDisplay(data);
    expect(display.attention[0]?.href).toBe("/tasks/task_xyz");
    expect(display.attention[0]?.title).toBe("needs API key");
    expect(display.attention[0]?.status).toBe("blocked");
    expect(display.attention[0]?.age).toBe("5m ago");
  });
});
