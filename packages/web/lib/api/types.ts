/**
 * Web-side re-exports of the read-DTO contract owned by `@beevibe/api`.
 *
 * Live shapes are defined in `packages/api/src/views/types.ts` so the
 * backend is the single source of truth for the read surface. Anything
 * the web computes locally (display-only types like ChainBudget, GraphNode,
 * dashboard KPI styling) stays in `lib/types/*` and isn't surfaced here.
 */

export type {
  TaskDetail,
  TaskDetailSessionRow,
  AgentDetail,
} from "@beevibe/api/views/types";

import type { ChainBudgetData, GraphNode, GraphEdge, MeshSummary, MeshAsk } from "@/lib/types/mesh";
import type {
  KpiStat,
  StatusBreakdownEntry,
  StatusLegendEntry,
  FleetBar,
  TrendDay,
  AttentionItem,
} from "@/lib/types/dashboard";

// ── Display-only shapes the web still composes from fixtures ────────────
// Dashboard + mesh need a data/display split before the backend can produce
// them cleanly — tracked in #33 and #34.

export interface DashboardSummary {
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
}

export interface MeshOverview {
  asks: MeshAsk[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  budget: ChainBudgetData;
  summary: MeshSummary;
}
