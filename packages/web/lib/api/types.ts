/**
 * Web-side re-exports of the read-DTO contract owned by `@beevibe/api`.
 *
 * Live shapes are defined in `packages/api/src/views/types.ts` so the
 * backend is the single source of truth for the read surface. Anything
 * the web computes locally (display-only types like ChainBudget, GraphNode,
 * mesh chrome) stays in `lib/types/*` and isn't surfaced here.
 */

export type {
  TaskDetail,
  TaskDetailSessionRow,
  AgentDetail,
  DashboardSummary,
} from "@beevibe/api/views/types";

import type { ChainBudgetData, GraphNode, GraphEdge, MeshSummary, MeshAsk } from "@/lib/types/mesh";

// Mesh still needs a data/display split before backend can produce it cleanly
// — tracked in #34.
export interface MeshOverview {
  asks: MeshAsk[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  budget: ChainBudgetData;
  summary: MeshSummary;
}
