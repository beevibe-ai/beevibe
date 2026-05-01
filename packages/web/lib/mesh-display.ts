/**
 * Pure-data → display mapping for the mesh page.
 *
 * Status compression: the backend has 5 ask statuses
 * ({in_flight, succeeded, rejected, blocked, escalated}) but the live UI
 * only paints 3 buckets ({in_flight, succeeded, blocked}). The mapper
 * lumps `rejected` + `escalated` into `blocked` since the visual treatment
 * is "ask didn't resolve cleanly".
 *
 * Geometry: delegated to `lib/mesh-layout.ts`.
 */

import type {
  MeshOverview,
  MeshAskData,
  MeshAsk,
  MeshAskStatus,
  MeshDisplay,
} from "@/lib/types/mesh";
import { layoutMeshGraph } from "@/lib/mesh-layout";
import { formatDurationLabel } from "@/lib/format";

export function overviewToDisplay(overview: MeshOverview): MeshDisplay {
  const { nodes, edges } = layoutMeshGraph(overview.graph.nodes, overview.graph.edges);
  return {
    asks: overview.asks.map(askToDisplay),
    graph: { nodes, edges },
    summary: { ...overview.summary },
  };
}

const DISPLAY_STATUS: Record<MeshAskStatus, MeshAsk["status"]> = {
  in_flight: "in_flight",
  succeeded: "succeeded",
  rejected: "blocked",
  blocked: "blocked",
  escalated: "blocked",
};

function askToDisplay(data: MeshAskData): MeshAsk {
  const display: MeshAsk = {
    id: data.id,
    caller: data.caller_label,
    target: data.target_label,
    type: data.type,
    status: DISPLAY_STATUS[data.status],
    duration_label: formatDurationLabel(data.started_at, data.completed_at),
    intent: data.intent,
    chain_depth:
      data.rounds_completed !== undefined && data.max_rounds !== undefined
        ? `${data.rounds_completed}/${data.max_rounds}`
        : "—",
  };
  return display;
}
