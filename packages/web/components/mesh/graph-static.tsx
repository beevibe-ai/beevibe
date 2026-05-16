"use client";

import { useMemo } from "react";
import { Network } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import type { GraphEdge, GraphNode, MeshHover } from "@/lib/types/mesh";

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

const MAX_LABEL_CHARS = 22;
function truncateLabel(s: string): string {
  return s.length <= MAX_LABEL_CHARS ? s : `${s.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

interface Props {
  nodes?: readonly GraphNode[];
  edges?: readonly GraphEdge[];
  hover?: MeshHover;
  selectedAgent?: string | null;
  onHoverNode?: (label: string | null) => void;
  onClickNode?: (label: string) => void;
  /** Defaults to 480 — matches `mesh-layout.ts`. */
  viewBox?: { width: number; height: number };
}

export function MeshGraphStatic({
  nodes = [],
  edges = [],
  hover = null,
  selectedAgent = null,
  onHoverNode,
  onClickNode,
  viewBox = { width: 480, height: 480 },
}: Props) {
  const empty = nodes.length === 0;

  const labelToId = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.label, n.id);
    return m;
  }, [nodes]);

  // Compute which edges + nodes should be highlighted. `null` means no
  // highlight is active (everything renders at full intensity).
  const { highlightEdges, highlightNodes, hasHighlight } = useMemo(() => {
    const selectedId = selectedAgent ? labelToId.get(selectedAgent) ?? null : null;

    if (hover?.kind === "row") {
      const c = labelToId.get(hover.caller);
      const t = labelToId.get(hover.target);
      const edgeSet = new Set<string>();
      const nodeSet = new Set<string>();
      if (c && t) {
        edgeSet.add(`${c}->${t}`);
        edgeSet.add(`${t}->${c}`);
      }
      if (c) nodeSet.add(c);
      if (t) nodeSet.add(t);
      return { highlightEdges: edgeSet, highlightNodes: nodeSet, hasHighlight: true };
    }

    const focusId = hover?.kind === "node" ? labelToId.get(hover.label) ?? null : selectedId;
    if (focusId) {
      const edgeSet = new Set<string>();
      for (const e of edges) {
        if (e.from === focusId || e.to === focusId) edgeSet.add(`${e.from}->${e.to}`);
      }
      return {
        highlightEdges: edgeSet,
        highlightNodes: new Set([focusId]),
        hasHighlight: true,
      };
    }

    return {
      highlightEdges: null as Set<string> | null,
      highlightNodes: null as Set<string> | null,
      hasHighlight: false,
    };
  }, [hover, selectedAgent, labelToId, edges]);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-[11px] uppercase tracking-wider text-muted-foreground">
          Live graph · last 24h
        </h2>
        <div className="text-[11px] text-muted-foreground">
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
            {edges.map((e, i) => {
              const key = `${e.from}->${e.to}`;
              const isHit = highlightEdges?.has(key) ?? false;
              const dim = hasHighlight && !isHit;
              return (
                <path
                  key={`${e.from}-${e.to}-${i}`}
                  d={e.d}
                  className={cn(
                    "fill-none transition-opacity duration-150",
                    EDGE_STROKE[e.state],
                    isHit ? "stroke-[2.5]" : "stroke-2",
                  )}
                  style={{ opacity: dim ? 0.15 : 1 }}
                  strokeLinecap="round"
                />
              );
            })}
            {nodes.map((n) => {
              const isHit = highlightNodes?.has(n.id) ?? false;
              const dim = hasHighlight && !isHit;
              const isSelected = selectedAgent === n.label;
              return (
                <g
                  key={n.id}
                  className="cursor-pointer transition-opacity duration-150"
                  style={{ opacity: dim ? 0.3 : 1 }}
                  onMouseEnter={() => onHoverNode?.(n.label)}
                  onMouseLeave={() => onHoverNode?.(null)}
                  onClick={() => onClickNode?.(n.label)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onClickNode?.(n.label);
                    }
                  }}
                  aria-label={`${n.label} — ${isSelected ? "selected" : "click to filter"}`}
                >
                  {/* Larger transparent hit target so hover doesn't flicker */}
                  <circle cx={n.cx} cy={n.cy} r={n.r + 10} fill="transparent" />
                  <circle
                    cx={n.cx}
                    cy={n.cy}
                    r={isHit ? n.r + 2 : n.r}
                    className={cn("stroke-[3] transition-all", NODE_FILL[n.state], HIER_RING[n.hier])}
                  />
                  <text
                    x={n.cx}
                    y={n.cy + n.r + 14}
                    textAnchor="middle"
                    fontSize="11"
                    fontWeight={isHit ? 600 : 400}
                    fill="hsl(var(--foreground))"
                    fontFamily="JetBrains Mono"
                  >
                    {truncateLabel(n.label)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
      </div>
      {!empty ? (
        <p className="mt-2 text-[10px] text-muted-foreground">
          Hover a node to highlight its asks · click to filter the feed
        </p>
      ) : null}
    </section>
  );
}
