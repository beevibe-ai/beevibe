import { Network } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import type { GraphEdge, GraphNode } from "@/lib/types/mesh";

const NODE_FILL: Record<GraphNode["state"], string> = {
  active: "fill-status-running",
  blocked: "fill-status-blocked",
  idle: "fill-muted-foreground",
};

const EDGE_STROKE: Record<GraphEdge["state"], string> = {
  live: "stroke-status-running",
  blocker: "stroke-status-blocked",
  completed: "stroke-muted-foreground/40",
};

const HIER_RING: Record<GraphNode["hier"], string> = {
  org: "stroke-hier-org",
  team: "stroke-hier-team",
  ic: "stroke-hier-ic",
};

interface Props {
  nodes?: readonly GraphNode[];
  edges?: readonly GraphEdge[];
  /** Defaults to 480 — matches `mesh-layout.ts`. */
  viewBox?: { width: number; height: number };
}

export function MeshGraphStatic({
  nodes = [],
  edges = [],
  viewBox = { width: 480, height: 480 },
}: Props) {
  const empty = nodes.length === 0;
  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Live graph · last 24h
        </h2>
        <div className="text-[10px] text-muted-foreground">
          <span className="text-foreground tabular-nums">{edges.length}</span> edges ·{" "}
          <span className="text-foreground tabular-nums">{nodes.length}</span> agents
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {empty ? (
          <div className="h-[480px] flex items-center justify-center">
            <EmptyState
              icon={Network}
              title="No mesh activity"
              description="The graph populates as agents ask each other for help."
            />
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${viewBox.width} ${viewBox.height}`}
            className="w-full h-[480px]"
            aria-label="Mesh activity graph"
          >
            {edges.map((e, i) => (
              <path
                key={`${e.from}-${e.to}-${i}`}
                d={e.d}
                className={cn("fill-none stroke-2", EDGE_STROKE[e.state])}
                strokeLinecap="round"
              />
            ))}
            {nodes.map((n) => (
              <g key={n.id}>
                <circle
                  cx={n.cx}
                  cy={n.cy}
                  r={n.r}
                  className={cn(
                    "stroke-[3]",
                    NODE_FILL[n.state],
                    HIER_RING[n.hier],
                  )}
                />
                <text
                  x={n.cx}
                  y={n.cy + n.r + 14}
                  textAnchor="middle"
                  fontSize="11"
                  fill="hsl(var(--foreground))"
                  fontFamily="JetBrains Mono"
                >
                  {n.label}
                </text>
              </g>
            ))}
          </svg>
        )}
      </div>
    </section>
  );
}
