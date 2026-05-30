import { useMemo, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
} from "@xyflow/react";
import dagre from "dagre";
import "@xyflow/react/dist/style.css";

// Each top-level branch gets one of these accent colors so the visual
// grouping is obvious at a glance. Periwinkle (the brand) leads.
const BRANCH_PALETTE = [
  "#b9c5ff", // periwinkle
  "#ffb9d5", // pink
  "#9ee3c6", // mint
  "#ffd7a3", // peach
  "#c8a7ff", // violet
  "#7fd7ff", // sky
];

// React Flow custom node — a pill card with title that highlights on selection.
function MapNode({ data }) {
  const { title, color, kind, isSelected } = data;
  return (
    <div
      className={`cb-mn cb-mn-${kind} ${isSelected ? "cb-mn-selected" : ""}`}
      style={{
        borderColor: color,
        boxShadow: isSelected ? `0 0 0 2px ${color}, 0 0 20px ${color}55` : undefined,
      }}
    >
      {kind !== "root" && (
        <Handle type="target" position={Position.Left} className="cb-mn-handle" />
      )}
      <div className="cb-mn-title" style={{ color: kind === "leaf" ? undefined : color }}>
        {title}
      </div>
      {kind !== "leaf" && (
        <Handle type="source" position={Position.Right} className="cb-mn-handle" />
      )}
    </div>
  );
}

const nodeTypes = { mapNode: MapNode };

// Build React Flow nodes + edges from the capsule.map JSON. Uses dagre to
// compute a left-to-right horizontal tree layout.
function buildGraph(map, rootTitle, selectedId) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",
    nodesep: 24,
    ranksep: 80,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const ROOT_ID = "__root";
  const ROOT_W = 200;
  const ROOT_H = 56;
  const BRANCH_W = 240;
  const BRANCH_H = 64;
  const LEAF_W = 220;
  const LEAF_H = 52;

  g.setNode(ROOT_ID, { width: ROOT_W, height: ROOT_H });

  const nodes = [
    {
      id: ROOT_ID,
      type: "mapNode",
      data: {
        title: rootTitle,
        color: "#dde3ff",
        kind: "root",
        isSelected: false,
      },
      position: { x: 0, y: 0 },
    },
  ];
  const edges = [];

  map.branches.forEach((branch, i) => {
    const color = BRANCH_PALETTE[i % BRANCH_PALETTE.length];
    g.setNode(branch.id, { width: BRANCH_W, height: BRANCH_H });
    g.setEdge(ROOT_ID, branch.id);
    nodes.push({
      id: branch.id,
      type: "mapNode",
      data: {
        title: branch.title,
        summary: branch.summary,
        color,
        kind: "branch",
        isSelected: selectedId === branch.id,
        rawNode: branch,
      },
      position: { x: 0, y: 0 },
    });
    edges.push({
      id: `e-${ROOT_ID}-${branch.id}`,
      source: ROOT_ID,
      target: branch.id,
      type: "smoothstep",
      style: { stroke: color, strokeWidth: 2, opacity: 0.85 },
    });

    (branch.children || []).forEach((child) => {
      g.setNode(child.id, { width: LEAF_W, height: LEAF_H });
      g.setEdge(branch.id, child.id);
      nodes.push({
        id: child.id,
        type: "mapNode",
        data: {
          title: child.title,
          summary: child.summary,
          color,
          kind: "leaf",
          isSelected: selectedId === child.id,
          rawNode: child,
        },
        position: { x: 0, y: 0 },
      });
      edges.push({
        id: `e-${branch.id}-${child.id}`,
        source: branch.id,
        target: child.id,
        type: "smoothstep",
        style: { stroke: color, strokeWidth: 1.5, opacity: 0.55 },
      });
    });
  });

  dagre.layout(g);

  nodes.forEach((n) => {
    const ln = g.node(n.id);
    n.position = { x: ln.x - ln.width / 2, y: ln.y - ln.height / 2 };
  });

  return { nodes, edges };
}

export default function MindMap({ map, selectedId, onSelectNode }) {
  const { nodes, edges } = useMemo(
    () => buildGraph(map, "Session", selectedId),
    [map, selectedId]
  );
  const handleNodeClick = useCallback(
    (_event, rfNode) => {
      const raw = rfNode.data?.rawNode;
      if (raw) onSelectNode?.(raw);
    },
    [onSelectNode]
  );

  if (!map?.branches?.length) return null;

  return (
    <div className="cb-mindmap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        panOnScroll
        zoomOnScroll={false}
        minZoom={0.4}
        maxZoom={1.6}
        nodesDraggable={false}
      >
        <Background gap={24} size={1} color="rgba(255,255,255,0.04)" />
        <Controls showInteractive={false} className="cb-mn-controls" />
      </ReactFlow>
    </div>
  );
}
