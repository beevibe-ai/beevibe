import type { RichText } from "@/components/rich-text";

// ── Display shapes the mesh page binds against ────────────────────────────
//
// Produced by `lib/mesh-display.ts:overviewToDisplay()` from the pure-data
// `MeshOverview` shipped by the backend. Backend never computes SVG
// geometry, status colors, or relative-time labels.

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

/** Aggregated display the mesh page binds to. */
export interface MeshDisplay {
  asks: MeshAsk[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  summary: MeshSummary;
}

/**
 * Cross-component hover state. Lets a row hover light up the matching graph
 * edge, and a node hover dim non-touching rows. Lifted into the mesh page so
 * the feed and graph can stay in sync without prop drilling further.
 */
export type MeshHover =
  | { kind: "row"; askId: string; caller: string; target: string }
  | { kind: "node"; label: string }
  | null;

// ── Re-export the backend data DTO ────────────────────────────────────────

export type {
  MeshOverview,
  MeshAskData,
  MeshAskType,
  MeshAskStatus,
  GraphNodeData,
  GraphEdgeData,
  MeshSummaryData,
} from "@beevibe/api/views/types";
