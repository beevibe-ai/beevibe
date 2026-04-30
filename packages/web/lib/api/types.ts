import type { WorkProduct } from "@beevibe/core";
import type { TaskListItem } from "@/lib/types/tasks";
import type { AgentDisplay, RecentSession, OutgoingMeshHint } from "@/lib/types/agents";
import type { CoreBlockDisplay, AgentMetrics } from "@/lib/types/core-memory-blocks";
import type {
  KpiStat,
  StatusBreakdownEntry,
  StatusLegendEntry,
  FleetBar,
  TrendDay,
  AttentionItem,
} from "@/lib/types/dashboard";
import type { ChainBudgetData, GraphNode, GraphEdge, MeshSummary, MeshAsk } from "@/lib/types/mesh";
import type { ThreadEvent, ThreadChannel, DirectMessage, ActiveChannel } from "@/lib/types/thread-messages";

export interface TaskDetail extends TaskListItem {
  work_products: WorkProduct[];
  sessions: TaskDetailSessionRow[];
}

export interface TaskDetailSessionRow {
  id: string;
  short_id: string;
  agent_id: string;
  agent_label: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  started_at: Date;
  duration_label: string;
  result_summary?: string;
}

export interface AgentDetail extends AgentDisplay {
  core_blocks: CoreBlockDisplay[];
  metrics: AgentMetrics;
  recent_sessions: RecentSession[];
  outgoing_mesh_hints: OutgoingMeshHint[];
}

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

export interface ThreadsOverview {
  channels: ThreadChannel[];
  direct_messages: DirectMessage[];
  active_channel?: ActiveChannel;
}

export interface ThreadDetail {
  channel: ActiveChannel;
  events: ThreadEvent[];
}
