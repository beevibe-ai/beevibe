import type { TaskStatus } from "@beevibe/core";

// ── Display shapes the home page binds against ─────────────────────────────
//
// These are produced by `lib/dashboard-display.ts:summaryToDisplay()` from
// the pure-data `DashboardSummary` shipped by the backend. Backend never
// computes colors, hrefs, or sparkline geometry.

export type KpiMetaColor = "muted" | "review" | "done" | "failed";

export interface KpiMetaPart {
  text: string;
  color?: KpiMetaColor;
}

export interface KpiStat {
  label: string;
  value: string;
  unit?: string;
  meta: KpiMetaPart[];
  href: string;
  trend: number[];
  trend_color: "running" | "review" | "primary" | "done";
  trend_kind: "line" | "bar";
  bar_opacities?: number[];
}

export interface StatusBreakdownEntry {
  status: TaskStatus | "running_group" | "pending_group";
  label: string;
  color: "pending" | "running" | "review" | "blocked" | "done" | "failed";
  count: number;
  percent: number;
  opacity?: number;
}

export interface StatusLegendEntry {
  color: "review" | "done" | "blocked" | "failed" | "running" | "pending";
  label: string;
  count: number;
}

export interface FleetBar {
  hier: "org" | "team" | "ic";
  count: number;
  percent: number;
}

export interface TrendDay {
  label: string;
  value: number;
  is_today?: boolean;
}

export interface AttentionItem {
  status: "blocked" | "failed" | "review";
  title: string;
  age: string;
  href: string;
}

/** Aggregated display-shaped dashboard the home page binds to. */
export interface DashboardDisplay {
  kpis: KpiStat[];
  status_breakdown: StatusBreakdownEntry[];
  status_legend: StatusLegendEntry[];
  status_total: number;
  fleet: FleetBar[];
  fleet_total: number;
  fleet_active: number;
  fleet_idle: number;
  trend: TrendDay[];
  trend_total: number;
  trend_change_percent: number;
  attention: AttentionItem[];
  /**
   * Pure-data pass-through. Usage rendering (cost formatting, color
   * bands, per-agent bars) lives in the dashboard component since
   * UsageSummaryData is already in scalar form — no URL/label/sparkline
   * derivation needed at the transformer layer.
   */
  usage_summary: UsageSummaryData;
}

// ── Re-export the backend data DTO ─────────────────────────────────────────

export type {
  DashboardSummary,
  KpiKind,
  KpiData,
  StatusBreakdownData,
  StatusLegendData,
  LegendBucket,
  FleetBarData,
  TrendDayData,
  AttentionData,
  UsageSummaryData,
  UsageAgentBreakdown,
} from "@beevibe/api/views/types";

import type { UsageSummaryData } from "@beevibe/api/views/types";
