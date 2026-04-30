"use client";

import { AlertTriangle, Info, Network } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { MeshActivityFeed } from "@/components/mesh/activity-feed";
import { MeshGraphStatic } from "@/components/mesh/graph-static";
import { ChainBudget } from "@/components/mesh/chain-budget";
import { useMeshOverview } from "@/lib/hooks/use-mesh";
import { isApiConfigured } from "@/lib/api/config";
import type { MeshOverview } from "@/lib/api/types";
import type { MeshAsk } from "@/lib/types/mesh";

export function MeshClient() {
  const { data, isLoading, isError } = useMeshOverview();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto pt-8 pb-12 px-6">
        <div className="mb-6 flex items-baseline justify-between gap-6">
          <div>
            <h1 className="text-base font-semibold mb-1">Mesh activity</h1>
            <p className="text-sm text-muted-foreground max-w-prose leading-relaxed">
              Agents ask each other when their bounded context isn&rsquo;t enough. Each ask is a session
              — caller&rsquo;s intent, target&rsquo;s response, with provenance.{" "}
              <span className="font-mono text-foreground">ChainBudget</span> caps depth and total
              tokens per chain to prevent runaway loops.
            </p>
          </div>
        </div>

        <Body data={data} isLoading={isLoading} isError={isError} />

        <div className="mt-10 text-xs text-muted-foreground flex items-start gap-2 max-w-2xl">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            <span className="text-foreground/80">Each ask is a session.</span> Caller and target
            agents stay bounded — neither dumps its memory into a shared pool. The target answers
            from its own context; the caller incorporates the answer into its work.{" "}
            <span className="font-mono">ChainBudget</span> caps depth and total tokens to prevent
            runaway asks.
          </span>
        </div>
      </div>
    </div>
  );
}

function Body({
  data,
  isLoading,
  isError,
}: {
  data: MeshOverview | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (!isApiConfigured) {
    return (
      <div className="rounded-lg border border-dashed border-border">
        <EmptyState
          icon={Network}
          title="No mesh asks yet"
          description="Set NEXT_PUBLIC_BV_API_URL and run the MCP server to load mesh activity."
        />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-dashed border-border">
        <EmptyState icon={AlertTriangle} title="Couldn't load mesh activity" />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-5 gap-6">
        <div className="col-span-3 space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
        <div className="col-span-2">
          <Skeleton className="h-[480px] rounded-lg" />
        </div>
      </div>
    );
  }

  if (!data || data.asks.length === 0) {
    return (
      <div className="grid grid-cols-5 gap-6">
        <MeshActivityFeed />
        <div className="col-span-2">
          <MeshGraphStatic />
          <ChainBudget />
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-5 gap-6">
      <section className="col-span-3">
        <h2 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
          Recent asks{" "}
          <span className="text-muted-foreground/70 tabular-nums">{data.asks.length}</span>
        </h2>
        <ul className="space-y-2">
          {data.asks.map((ask) => (
            <AskRow key={ask.id} ask={ask} />
          ))}
        </ul>
      </section>
      <div className="col-span-2 space-y-3">
        <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
          <div className="text-[10px] uppercase tracking-wider mb-2 text-foreground">
            Live graph · last 24h
          </div>
          <div>
            <span className="text-foreground tabular-nums">{data.graph.edges.length}</span> edges ·{" "}
            <span className="text-foreground tabular-nums">{data.graph.nodes.length}</span> agents
          </div>
        </div>
        <ChainBudget />
      </div>
    </div>
  );
}

function AskRow({ ask }: { ask: MeshAsk }) {
  return (
    <li className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
        <span className="text-foreground/85">{ask.caller}</span>
        <span>→</span>
        <span className="text-foreground/85">{ask.target}</span>
        <span className="ml-auto tabular-nums">{ask.duration_label}</span>
      </div>
    </li>
  );
}
