import { MeshActivityFeed } from "@/components/mesh/activity-feed";
import { MeshGraphStatic } from "@/components/mesh/graph-static";
import { ThreadsSubNav } from "@/components/threads/sub-nav";
import { fixtureMeshSummary } from "@/lib/fixtures/mesh";

export default function MeshPage() {
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto pt-8 pb-12 px-6">
        <ThreadsSubNav />

        <div className="mb-6 flex items-baseline justify-between gap-6">
          <div>
            <h1 className="text-base font-semibold mb-1">Mesh activity</h1>
            <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
              Agents ask each other when their bounded context isn&rsquo;t enough. Each ask is a session
              — caller&rsquo;s intent, target&rsquo;s response, with provenance.{" "}
              <span className="font-mono text-foreground">ChainBudget</span> caps depth and total
              tokens per chain to prevent runaway loops.
            </p>
          </div>
          <div className="text-xs text-muted-foreground shrink-0 text-right">
            <div>
              <span className="text-foreground tabular-nums">{fixtureMeshSummary.asks_24h}</span> asks
              · last 24h
            </div>
            <div className="mt-1">
              <span className="animate-pulse-breathe inline-block h-1.5 w-1.5 rounded-full bg-status-running mr-1.5" />
              <span className="text-status-running font-medium">
                {fixtureMeshSummary.in_flight} in flight
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-5 gap-6">
          <MeshActivityFeed />
          <MeshGraphStatic />
        </div>
      </div>
    </div>
  );
}
