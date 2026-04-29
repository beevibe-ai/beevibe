import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, KeyRound, Loader2, Settings2 } from "lucide-react";
import { CoreBlockCard } from "@/components/agents/core-block-card";
import { DepthMetrics } from "@/components/agents/depth-metrics";
import { ScopeChip } from "@/components/scope-chip";
import { FactTypeTag } from "@/components/fact-type-tag";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { fixtureAgents } from "@/lib/fixtures/agents";
import { fixtureAgentMetrics, fixtureCoreBlocks } from "@/lib/fixtures/core-memory-blocks";
import { fixtureFacts } from "@/lib/fixtures/memory-facts";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export function generateMetadata({ params }: { params: { id: string } }): Metadata {
  const agent = fixtureAgents.find((a) => a.id === params.id || a.name === params.id);
  return { title: agent ? agent.name : "Agent" };
}

const HIER_AVATAR_BG = {
  ic: "bg-hier-ic/10 text-hier-ic",
  team: "bg-hier-team/10 text-hier-team",
  org: "bg-hier-org/10 text-hier-org",
} as const;

const HIER_CHIP = {
  ic: "bg-hier-ic/15 text-hier-ic",
  team: "bg-hier-team/10 text-hier-team",
  org: "border border-hier-org text-hier-org",
} as const;

export default function AgentDetailPage({ params }: { params: { id: string } }) {
  const agent = fixtureAgents.find((a) => a.id === params.id || a.name === params.id);
  if (!agent) notFound();

  const metrics = fixtureAgentMetrics[agent.id];
  const blocks = fixtureCoreBlocks[agent.id] ?? [];
  const facts = fixtureFacts.filter((f) => f.agent_id === agent.id);
  const parent = agent.parent_agent_id
    ? fixtureAgents.find((a) => a.id === agent.parent_agent_id)
    : undefined;

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-5xl mx-auto px-6 py-8">
        <Link
          href="/agents"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Agents
        </Link>

        <header className="mb-6">
          <div className="flex items-start gap-4">
            <div className="relative shrink-0">
              <div
                className={cn(
                  "h-14 w-14 rounded-full flex items-center justify-center text-xl font-semibold",
                  HIER_AVATAR_BG[agent.hierarchy],
                )}
              >
                <KeyRound className="h-6 w-6" />
              </div>
              <span className="absolute bottom-0 right-0 h-3.5 w-3.5 rounded-full bg-status-running border-2 border-background animate-pulse-breathe" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h1 className="font-mono text-xl font-semibold leading-tight">{agent.name}</h1>
                <span
                  className={cn(
                    "inline-flex items-center h-5 px-2 rounded text-[10px] font-medium",
                    HIER_CHIP[agent.hierarchy],
                  )}
                >
                  {agent.hierarchy}
                </span>
                <span className="inline-flex items-center gap-1 h-5 px-2 rounded text-[10px] text-status-running bg-status-running/10">
                  <Loader2 className="animate-spin-slow h-3 w-3" />1 running
                </span>
              </div>
              <div className="text-sm text-muted-foreground">
                {parent ? (
                  <>
                    reports to{" "}
                    <Link href={`/agents/${parent.id}`} className="text-foreground hover:underline font-mono">
                      {parent.name}
                    </Link>
                  </>
                ) : (
                  <span>top-level agent</span>
                )}
              </div>
            </div>
            <button className="inline-flex items-center gap-1.5 h-8 px-3 rounded text-xs font-medium hover:bg-secondary cursor-pointer transition-colors text-muted-foreground hover:text-foreground shrink-0">
              <Settings2 className="h-3.5 w-3.5" />
              Configure
            </button>
          </div>

          {metrics ? (
            <DepthMetrics
              sessions={metrics.sessions}
              sessions_change={metrics.sessions_change}
              facts={metrics.facts}
              merges={metrics.merges}
              promoted={metrics.promoted}
            />
          ) : null}
        </header>

        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-5">
            {blocks.length > 0 ? (
              <section>
                <div className="flex items-baseline justify-between mb-3">
                  <h2 className="text-sm font-semibold">Core memory blocks</h2>
                  <span className="text-[10px] text-muted-foreground">
                    {blocks.length} blocks · agent-edited via{" "}
                    <span className="font-mono">update_core_memory</span>
                  </span>
                </div>
                <div className="space-y-3">
                  {blocks.map((b) => (
                    <CoreBlockCard key={b.id} block={b} />
                  ))}
                </div>
              </section>
            ) : null}

            {facts.length > 0 ? (
              <section>
                <div className="flex items-baseline justify-between mb-3">
                  <h2 className="text-sm font-semibold">Recent facts learned</h2>
                  <Link
                    href="/memory"
                    className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    View all →
                  </Link>
                </div>
                <div className="space-y-2">
                  {facts.map((fact) => (
                    <div
                      key={fact.id}
                      className="rounded-lg border border-border bg-card p-3 flex items-start gap-3"
                    >
                      <div className="flex flex-col items-center gap-1 shrink-0 mt-0.5">
                        <FactTypeTag type={fact.fact_type} />
                        <ScopeChip scope={fact.scope} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm leading-relaxed">{fact.content}</p>
                        <div className="mt-1.5 text-[10px] text-muted-foreground font-mono flex items-center gap-2">
                          <span>{fact.source_session_count} sessions</span>
                          <span className="text-border">·</span>
                          <span>{formatRelativeTime(fact.created_at)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <aside className="col-span-1 space-y-4">
            <section className="rounded-lg border border-border bg-card p-4">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Active session
              </h3>
              <Link
                href="/sessions/sess_3a8c"
                className="block group -mx-1 -my-1 px-1 py-1 rounded hover:bg-secondary/60 transition-colors"
              >
                <div className="text-sm font-medium leading-tight mb-1">
                  Wire OAuth refresh-token rotation
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <span className="font-mono">sess_3a8c</span>
                  <span className="text-border">·</span>
                  <span>4m elapsed</span>
                </div>
              </Link>
            </section>

            <section className="rounded-lg border border-dashed border-border p-4 text-center">
              <div className="text-xs text-muted-foreground">No outstanding mesh asks</div>
            </section>
          </aside>
        </div>

        <div className="mt-8 pt-4 border-t border-border flex items-center gap-3 text-xs text-muted-foreground">
          <ClickToCopyId id={agent.id.replace(/^[a-z]+_/, "")} />
          <span className="text-border">·</span>
          <span>
            Created <span className="text-foreground">{formatRelativeTime(agent.created_at)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
