import type { RichText } from "@/components/rich-text";

export interface MeshAsk {
  id: string;
  caller: string;
  target: string;
  intermediate?: string;
  arrow?: "right" | "up";
  type: "ask" | "negotiate" | "blocker";
  type_label?: string;
  status: "in_flight" | "succeeded" | "blocked";
  duration_label: string;
  intent: RichText;
  response?: { agent: string; content: RichText };
  chain_depth: string;
  chain_depth_color?: "review";
  source_session?: string;
  source_task_short_id?: string;
  source_task_age?: string;
  awaiting_label?: string;
  awaiting_task_short_id?: string;
}

export interface ChainBudgetRow {
  used_label: string;
  max_label: string;
  percent: number;
  color: "done" | "review" | "primary";
}

export interface ChainBudgetData {
  avg_depth: ChainBudgetRow;
  max_depth: ChainBudgetRow;
  tokens: ChainBudgetRow;
}

export interface GraphNode {
  id: string;
  label: string;
  hier_label: string;
  hier: "ic" | "team" | "org";
  cx: number;
  cy: number;
  r: number;
  state: "active" | "blocked" | "idle";
}

export interface GraphEdge {
  from: string;
  to: string;
  d: string;
  state: "live" | "blocker" | "completed";
  label?: { text: string; x: number; y: number };
}

export interface MeshSummary {
  asks_24h: number;
  in_flight: number;
  edge_count: number;
}
