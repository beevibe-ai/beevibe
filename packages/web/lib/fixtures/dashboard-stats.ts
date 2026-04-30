import type { TaskStatus } from "@beevibe/core";

export interface KpiStat {
  label: string;
  value: string;
  unit?: string;
  meta: string;
  meta_color?: "muted" | "review" | "done" | "failed";
  href: string;
  trend: number[];
  trend_color: "running" | "review" | "primary" | "done";
  trend_kind: "line" | "bar";
}

export const fixtureKpis: KpiStat[] = [
  {
    label: "Active sessions",
    value: "3",
    unit: "running",
    meta: "4m oldest · 18m avg",
    href: "/threads",
    trend: [4, 6, 6, 10, 10, 14, 14, 12, 16, 18, 20, 20, 18],
    trend_color: "running",
    trend_kind: "line",
  },
  {
    label: "Awaiting your review",
    value: "7",
    unit: "tasks",
    meta: "oldest 1d · 3 high priority",
    meta_color: "review",
    href: "/tasks",
    trend: [4, 6, 8, 10, 8, 12, 14, 16, 16, 18, 18, 20, 20],
    trend_color: "review",
    trend_kind: "line",
  },
  {
    label: "Today's spend",
    value: "$4.21",
    meta: "+$0.42 vs yesterday",
    meta_color: "failed",
    href: "#",
    trend: [4, 6, 8, 8, 10, 12, 14, 14, 16, 18, 18, 20, 20],
    trend_color: "primary",
    trend_kind: "line",
  },
  {
    label: "Completed today",
    value: "12",
    unit: "tasks",
    meta: "+3 vs yesterday · 1 failed",
    meta_color: "done",
    href: "/tasks",
    trend: [10, 14, 18, 12, 16, 20, 18],
    trend_color: "done",
    trend_kind: "bar",
  },
];

export interface StatusBreakdownEntry {
  status: TaskStatus | "running_group" | "pending_group";
  label: string;
  color: "pending" | "running" | "review" | "blocked" | "done" | "failed";
  count: number;
  percent: number;
  opacity?: number;
}

export const fixtureStatusBreakdown: StatusBreakdownEntry[] = [
  { status: "pending", label: "pending", color: "pending", count: 8, percent: 17.0 },
  { status: "assigned", label: "assigned", color: "pending", count: 5, percent: 10.6, opacity: 0.6 },
  { status: "in_progress", label: "in progress", color: "running", count: 3, percent: 6.4 },
  { status: "revision", label: "revision", color: "running", count: 2, percent: 4.3, opacity: 0.7 },
  { status: "review", label: "review", color: "review", count: 7, percent: 14.9 },
  { status: "blocked", label: "blocked", color: "blocked", count: 2, percent: 4.3 },
  { status: "done", label: "done", color: "done", count: 14, percent: 29.8 },
  { status: "failed", label: "failed", color: "failed", count: 3, percent: 6.4 },
  { status: "cancelled", label: "cancelled", color: "pending", count: 3, percent: 6.4, opacity: 0.4 },
];

export const fixtureStatusTotal = 47;

export interface StatusLegendEntry {
  color: "review" | "done" | "blocked" | "failed" | "running" | "pending";
  label: string;
  count: number;
}

export const fixtureStatusLegend: StatusLegendEntry[] = [
  { color: "review", label: "Review", count: 7 },
  { color: "done", label: "Done", count: 14 },
  { color: "blocked", label: "Blocked", count: 2 },
  { color: "failed", label: "Failed", count: 3 },
  { color: "running", label: "In progress / revision", count: 5 },
  { color: "pending", label: "Pending / assigned / cancelled", count: 16 },
];

export const fixtureLeadLine = {
  date: "Sunday, April 26",
  fleet_health: "fleet healthy" as const,
  last_activity_seconds: 30,
};

export interface FleetBar {
  hier: "org" | "team" | "ic";
  count: number;
  percent: number;
}

export const fixtureFleetBars: FleetBar[] = [
  { hier: "org", count: 1, percent: 14.3 },
  { hier: "team", count: 2, percent: 28.6 },
  { hier: "ic", count: 4, percent: 57.1 },
];

export const fixtureFleetActive = { active: 4, idle: 3 };

export interface TrendDay {
  label: string;
  value: number;
  is_today?: boolean;
}

export const fixtureTrend7d: TrendDay[] = [
  { label: "Mon", value: 21 },
  { label: "Tue", value: 27 },
  { label: "Wed", value: 24 },
  { label: "Thu", value: 18 },
  { label: "Fri", value: 30 },
  { label: "Sat", value: 24 },
  { label: "Sun", value: 24, is_today: true },
];

export const fixtureTrendStats = { total: 142, change_percent: 12 };

export interface AttentionItem {
  status: "blocked" | "failed" | "review";
  title: string;
  age: string;
  href: string;
}

export const fixtureAttention: AttentionItem[] = [
  {
    status: "blocked",
    title: "OAuth provider configuration · blocked 3h, awaiting decision",
    age: "3h",
    href: "/tasks/tsk_2c8d4f00000000000000000000",
  },
  {
    status: "failed",
    title: "Backfill memory_fact embeddings · failed by ic-agent-2",
    age: "20h",
    href: "/tasks",
  },
  {
    status: "review",
    title: "Audit task dispatch index · in review 1d",
    age: "1d",
    href: "/tasks/tsk_5e3c8b00000000000000000000",
  },
];
