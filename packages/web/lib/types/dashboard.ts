import type { TaskStatus } from "@beevibe/core";

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
