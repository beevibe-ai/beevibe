import type {
  DashboardSummary,
  KpiKind,
  KpiData,
  StatusBreakdownData,
  StatusLegendData,
  LegendBucket,
  FleetBarData,
  TrendDayData,
  AttentionData,
  DashboardDisplay,
  KpiStat,
  StatusBreakdownEntry,
  StatusLegendEntry,
  FleetBar,
  TrendDay,
  AttentionItem,
} from "@/lib/types/dashboard";
import type { TaskStatus } from "@beevibe/core";
import { formatRelativeTime } from "@/lib/format";

/**
 * Pure-data → display mapping. Keeps the API uncoupled from web's URL
 * structure, CSS color names, and labelling choices.
 */
export function summaryToDisplay(summary: DashboardSummary): DashboardDisplay {
  return {
    kpis: summary.kpis.map(kpiToDisplay),
    status_breakdown: summary.status_breakdown.map(breakdownToDisplay),
    status_legend: summary.status_legend.map(legendToDisplay),
    status_total: summary.status_total,
    fleet: summary.fleet.map(fleetToDisplay),
    fleet_total: summary.fleet_total,
    fleet_active: summary.fleet_active,
    fleet_idle: summary.fleet_idle,
    trend: summary.trend.map(trendDayToDisplay),
    trend_total: summary.trend_total,
    trend_change_percent: summary.trend_change_percent,
    attention: summary.attention.map(attentionToDisplay),
    // Pure pass-through — usage rendering is component-local (see
    // DashboardUsageSection). Keeps the transformer focused on the
    // shapes that actually need URL/label/sparkline derivation.
    usage_summary: summary.usage_summary,
  };
}

// ── KPI ────────────────────────────────────────────────────────────────────

interface KpiConfig {
  label: string;
  href: string;
  trend_color: KpiStat["trend_color"];
  trend_kind: KpiStat["trend_kind"];
}

const KPI_CONFIG: Record<KpiKind, KpiConfig> = {
  active_sessions: {
    label: "Active sessions",
    href: "/tasks?lifecycle=in_progress",
    trend_color: "running",
    trend_kind: "line",
  },
  in_review: {
    label: "Awaiting review",
    href: "/tasks?lifecycle=in_review",
    trend_color: "review",
    trend_kind: "bar",
  },
  completed_today: {
    label: "Completed today",
    href: "/tasks?lifecycle=done",
    trend_color: "done",
    trend_kind: "line",
  },
  blocked: {
    label: "Blocked",
    href: "/tasks?lifecycle=in_review",
    trend_color: "primary",
    trend_kind: "bar",
  },
};

function kpiToDisplay(data: KpiData): KpiStat {
  const cfg = KPI_CONFIG[data.kind];
  return {
    label: cfg.label,
    value: String(data.value),
    unit: data.unit,
    meta: [],
    href: cfg.href,
    trend: data.trend,
    trend_color: cfg.trend_color,
    trend_kind: cfg.trend_kind,
  };
}

// ── Status breakdown ───────────────────────────────────────────────────────

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "Pending",
  assigned: "Assigned",
  in_progress: "In progress",
  needs_revision: "Needs revision",
  revision: "In revision",
  review: "In review",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_COLOR: Record<TaskStatus, StatusBreakdownEntry["color"]> = {
  pending: "pending",
  assigned: "pending",
  in_progress: "running",
  needs_revision: "running",
  revision: "running",
  review: "review",
  blocked: "blocked",
  done: "done",
  failed: "failed",
  cancelled: "pending",
};

function breakdownToDisplay(data: StatusBreakdownData): StatusBreakdownEntry {
  return {
    status: data.status,
    label: STATUS_LABEL[data.status],
    color: STATUS_COLOR[data.status],
    count: data.count,
    percent: data.percent,
  };
}

// ── Legend ─────────────────────────────────────────────────────────────────

const LEGEND_LABEL: Record<LegendBucket, string> = {
  pending: "Pending",
  running: "Running",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
  failed: "Failed",
};

function legendToDisplay(data: StatusLegendData): StatusLegendEntry {
  return {
    color: data.bucket,
    label: LEGEND_LABEL[data.bucket],
    count: data.count,
  };
}

// ── Fleet ──────────────────────────────────────────────────────────────────

function fleetToDisplay(data: FleetBarData): FleetBar {
  return {
    hier: data.hier,
    count: data.count,
    percent: data.percent,
  };
}

// ── Trend ──────────────────────────────────────────────────────────────────

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function trendDayToDisplay(data: TrendDayData): TrendDay {
  const label = DAY_LABELS[new Date(data.date + "T00:00:00Z").getUTCDay()] ?? data.date;
  return {
    label,
    value: data.value,
    is_today: data.is_today,
  };
}

// ── Attention ──────────────────────────────────────────────────────────────

function attentionToDisplay(data: AttentionData): AttentionItem {
  return {
    status: data.status,
    title: data.title,
    age: formatRelativeTime(data.created_at),
    href: `/tasks/${data.task_id}`,
  };
}
