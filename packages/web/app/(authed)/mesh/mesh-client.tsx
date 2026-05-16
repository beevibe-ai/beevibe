"use client";

import { useState } from "react";
import { AlertTriangle, Info, Network } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Skeleton } from "@/components/skeleton";
import { MeshAskSkeleton } from "@/components/skeletons";
import { MeshActivityFeed } from "@/components/mesh/activity-feed";
import { MeshGraphStatic } from "@/components/mesh/graph-static";
import { ChainBudget } from "@/components/mesh/chain-budget";
import { useMeshOverview } from "@/lib/hooks/use-mesh";
import { isApiConfigured } from "@/lib/api/config";
import type { MeshDisplay, MeshHover } from "@/lib/types/mesh";

export function MeshClient() {
  const { data, isLoading, isError } = useMeshOverview();

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto pt-8 pb-12 px-6">
        <div className="mb-6 flex items-baseline justify-between gap-6">
          <div>
            <h1 className="text-lg font-semibold tracking-tight mb-1">Mesh activity</h1>
            <p className="text-sm text-muted-foreground max-w-prose leading-relaxed">
              Agents ask each other when one agent&rsquo;s context isn&rsquo;t enough. Each ask is a
              session with caller intent, response, and provenance. We cap depth and tokens per
              chain so loops can&rsquo;t run away.
            </p>
          </div>
        </div>

        <Body data={data} isLoading={isLoading} isError={isError} />

        <div className="mt-10 text-xs text-muted-foreground flex items-start gap-2 max-w-2xl">
          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            Caller and target agents stay bounded — neither dumps its memory into a shared pool.
            The target answers from its own context; the caller incorporates the answer into its
            work.
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
  data: MeshDisplay | undefined;
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
            <MeshAskSkeleton key={i} />
          ))}
        </div>
        <div className="col-span-2">
          <Skeleton className="h-[480px] rounded-lg" />
        </div>
      </div>
    );
  }

  if (!data) return null;
  return <MeshContent data={data} />;
}

function MeshContent({ data }: { data: MeshDisplay }) {
  const [hover, setHover] = useState<MeshHover>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  return (
    <div className="grid grid-cols-5 gap-6">
      <MeshActivityFeed
        asks={data.asks}
        hover={hover}
        selectedAgent={selectedAgent}
        onHoverRow={(row) => setHover(row ? { kind: "row", ...row } : null)}
        onClearSelection={() => setSelectedAgent(null)}
      />
      <div className="col-span-2 space-y-3">
        <MeshGraphStatic
          nodes={data.graph.nodes}
          edges={data.graph.edges}
          hover={hover}
          selectedAgent={selectedAgent}
          onHoverNode={(label) => setHover(label ? { kind: "node", label } : null)}
          onClickNode={(label) =>
            setSelectedAgent((current) => (current === label ? null : label))
          }
        />
        <ChainBudget />
      </div>
    </div>
  );
}
