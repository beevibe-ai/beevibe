import { fixtureGraph, fixtureMeshSummary, type GraphEdge, type GraphNode } from "@/lib/fixtures/mesh";

const HIER_STROKE = {
  ic: "hsl(var(--hier-ic))",
  team: "hsl(var(--hier-team))",
  org: "hsl(var(--hier-org))",
} as const;

const HIER_LABEL_FILL = {
  ic: "hsl(var(--hier-ic))",
  team: "hsl(var(--hier-team))",
  org: "hsl(var(--hier-org))",
} as const;

const EDGE_COLOR = {
  live: "hsl(var(--status-running))",
  blocker: "hsl(var(--status-blocked))",
  completed: "hsl(var(--muted-foreground))",
} as const;

export function MeshGraphStatic() {
  return (
    <section className="col-span-2">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Live graph · last 24h
        </h2>
        <div className="text-[10px] text-muted-foreground">
          <span className="text-foreground tabular-nums">{fixtureMeshSummary.edge_count}</span> edges
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <svg viewBox="0 0 320 480" className="w-full h-[480px]">
          <defs>
            <Arrowhead id="arr" fill="hsl(var(--muted-foreground))" />
            <Arrowhead id="arr-live" fill="hsl(var(--status-running))" />
            <Arrowhead id="arr-blocked" fill="hsl(var(--status-blocked))" />
          </defs>

          {fixtureGraph.edges.map((edge, i) => (
            <Edge key={i} edge={edge} />
          ))}

          {fixtureGraph.nodes.map((node) => (
            <Node key={node.id} node={node} />
          ))}
        </svg>

        <div className="px-3 py-2.5 border-t border-border text-[10px] text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <LegendItem stroke="hsl(var(--status-running))" label="in-flight ask" dashed />
          <LegendItem stroke="hsl(var(--status-blocked))" label="blocker" dashed />
          <LegendItem stroke="hsl(var(--muted-foreground))" label="completed" />
        </div>
      </div>
    </section>
  );
}

function Arrowhead({ id, fill }: { id: string; fill: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="6"
      markerHeight="6"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill={fill} />
    </marker>
  );
}

function Edge({ edge }: { edge: GraphEdge }) {
  const color = EDGE_COLOR[edge.state];
  const marker =
    edge.state === "live" ? "url(#arr-live)" : edge.state === "blocker" ? "url(#arr-blocked)" : "url(#arr)";
  const dash = edge.state === "blocker" ? "2 3" : undefined;
  const opacity = edge.state === "completed" ? 0.5 : 1;
  return (
    <>
      <path
        d={edge.d}
        fill="none"
        stroke={color}
        strokeWidth={edge.state === "completed" ? 1 : 1.5}
        strokeOpacity={opacity}
        strokeDasharray={dash}
        markerEnd={marker}
      />
      {edge.label ? (
        <text
          x={edge.label.x}
          y={edge.label.y}
          fontSize="9"
          fill={color}
          fontFamily="JetBrains Mono"
        >
          {edge.label.text}
        </text>
      ) : null}
    </>
  );
}

function Node({ node }: { node: GraphNode }) {
  const stroke = node.state === "blocked" ? "hsl(var(--status-blocked))" : HIER_STROKE[node.hier];
  const labelFill =
    node.state === "blocked" ? "hsl(var(--status-blocked))" : HIER_LABEL_FILL[node.hier];
  return (
    <g>
      {node.state === "active" ? (
        <circle
          cx={node.cx}
          cy={node.cy}
          r={node.r + 2}
          fill="hsl(var(--status-running))"
          fillOpacity="0.25"
        />
      ) : null}
      <circle
        cx={node.cx}
        cy={node.cy}
        r={node.r}
        fill="hsl(var(--card))"
        stroke={stroke}
        strokeWidth="1.5"
      />
      <text
        x={node.cx}
        y={node.cy + 4}
        textAnchor="middle"
        fontSize="9"
        fontWeight="600"
        fill="hsl(var(--foreground))"
        fontFamily="JetBrains Mono"
      >
        {node.label}
      </text>
      <text
        x={node.cx}
        y={node.cy + node.r + 14}
        textAnchor="middle"
        fontSize="9"
        fill={labelFill}
      >
        {node.hier_label}
      </text>
    </g>
  );
}

function LegendItem({ stroke, label, dashed }: { stroke: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="14" height="6">
        <line
          x1="0"
          y1="3"
          x2="14"
          y2="3"
          stroke={stroke}
          strokeWidth="1.5"
          strokeDasharray={dashed ? "3 2" : undefined}
        />
      </svg>
      <span>{label}</span>
    </span>
  );
}
