/**
 * Simple radial layout for the mesh graph. Backend ships node IDs + edge
 * pairs; this computes 2D positions for SVG rendering. Web-only — backend
 * never computes geometry.
 *
 * Algorithm: place nodes evenly around a circle, ordered by hierarchy
 * (org outermost, then team, then ic) so the visual matches the org
 * structure. Edges are straight lines between source and target centers.
 *
 * Phase 2 could swap this for a force-directed layout (dagre/d3-force)
 * once the graph density justifies it. For phase 1 — typically <10 nodes
 * per page — a circle is enough.
 */

import type { GraphEdge, GraphNode, GraphEdgeData, GraphNodeData } from "@/lib/types/mesh";

const VIEWBOX_W = 480;
const VIEWBOX_H = 480;
const NODE_RADIUS = 14;

interface LaidOut {
  nodes: GraphNode[];
  edges: GraphEdge[];
  viewBox: { width: number; height: number };
}

const HIER_ORDER: Record<GraphNode["hier"], number> = {
  org: 0,
  team: 1,
  ic: 2,
};

const EDGE_STATE: Record<GraphEdgeData["state"], GraphEdge["state"]> = {
  live: "live",
  completed: "completed",
};

const NODE_STATE: Record<GraphNodeData["state"], GraphNode["state"]> = {
  active: "active",
  idle: "idle",
};

export function layoutMeshGraph(
  nodeData: readonly GraphNodeData[],
  edgeData: readonly GraphEdgeData[],
): LaidOut {
  if (nodeData.length === 0) {
    return { nodes: [], edges: [], viewBox: { width: VIEWBOX_W, height: VIEWBOX_H } };
  }

  const center = { x: VIEWBOX_W / 2, y: VIEWBOX_H / 2 };
  // Generous inset so long labels (e.g. "Platform & Release specialist")
  // don't get clipped at the left/right viewBox edges.
  const radius = Math.min(VIEWBOX_W, VIEWBOX_H) / 2 - NODE_RADIUS - 80;

  const ordered = [...nodeData].sort(
    (a, b) => HIER_ORDER[a.hier] - HIER_ORDER[b.hier] || a.label.localeCompare(b.label),
  );

  const positions = new Map<string, { cx: number; cy: number }>();
  const nodes: GraphNode[] = ordered.map((n, i) => {
    const theta = (2 * Math.PI * i) / ordered.length - Math.PI / 2;
    const cx = center.x + radius * Math.cos(theta);
    const cy = center.y + radius * Math.sin(theta);
    positions.set(n.id, { cx, cy });
    return {
      id: n.id,
      label: n.label,
      hier: n.hier,
      cx,
      cy,
      r: NODE_RADIUS,
      state: NODE_STATE[n.state],
    };
  });

  const edges: GraphEdge[] = edgeData.flatMap((e) => {
    const from = positions.get(e.from);
    const to = positions.get(e.to);
    if (!from || !to) return [];
    return [
      {
        from: e.from,
        to: e.to,
        d: `M${from.cx.toFixed(1)} ${from.cy.toFixed(1)} L${to.cx.toFixed(1)} ${to.cy.toFixed(1)}`,
        state: EDGE_STATE[e.state],
      },
    ];
  });

  return { nodes, edges, viewBox: { width: VIEWBOX_W, height: VIEWBOX_H } };
}
