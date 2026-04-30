import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  Circle,
  GitMerge,
  KeyRound,
  Loader2,
  Settings2,
  TrendingUp,
} from "lucide-react";
import { CoreBlockCard } from "@/components/agents/core-block-card";
import { DepthMetrics } from "@/components/agents/depth-metrics";
import { ScopeChip } from "@/components/scope-chip";
import { FactTypeTag } from "@/components/fact-type-tag";
import { ClickToCopyId } from "@/components/detail/click-to-copy-id";
import { RichTextRender } from "@/components/rich-text";
import {
  fixtureAgentMeshHints,
  fixtureAgentRecentSessions,
  fixtureAgents,
  type RecentSession,
} from "@/lib/fixtures/agents";
import { fixtureAgentMetrics, fixtureCoreBlocks } from "@/lib/fixtures/core-memory-blocks";
import { fixtureFacts, type MergeOrigin } from "@/lib/fixtures/memory-facts";
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

const SESSION_STATUS_ICON: Record<RecentSession["status"], { Icon: typeof Loader2; className: string; spin?: boolean }> = {
  running: { Icon: Loader2, className: "text-status-running", spin: true },
  succeeded: { Icon: CheckCircle2, className: "text-status-done" },
  review: { Icon: AlertCircle, className: "text-status-review" },
};

export default function AgentDetailPage({ params }: { params: { id: string } }) {
  const agent = fixtureAgents.find((a) => a.id === params.id || a.name === params.id);
  if (!agent) notFound();

  const metrics = fixtureAgentMetrics[agent.id];
  const blocks = fixtureCoreBlocks[agent.id] ?? [];
  const facts = fixtureFacts.filter((f) => f.agent_id === agent.id);
  const parent = agent.parent_agent_id
    ? fixtureAgents.find((a) => a.id === agent.parent_agent_id)
    : undefined;
  const recentSessions = fixtureAgentRecentSessions[agent.id] ?? [];
  const meshHints = fixtureAgentMeshHints[agent.id] ?? [];

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
                      className="rounded-lg border border-border bg-card p-3.5 hover:border-ring/40 transition-colors cursor-pointer"
                    >
                      <div className="flex items-start gap-3">
                        <FactOriginIcon origin={fact.merge_origin} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm leading-relaxed">
                            <RichTextRender value={fact.content} />
                          </p>
                          <div className="flex items-center gap-2 mt-2 text-[10px]">
                            <ScopeChip scope={fact.scope} className="h-4 px-1.5 text-[10px]" />
                            <FactTypeTag type={fact.fact_type} />
                            <span className="text-muted-foreground font-mono">
                              {factMetaLabel(fact.merge_origin, fact.promotion_origin_scope, fact.source_session_count, fact.created_at)}
                            </span>
                            {fact.merge_origin === "promoted" ? (
                              <Link
                                href="/promotions"
                                className="text-muted-foreground hover:text-foreground underline transition-colors"
                              >
                                why?
                              </Link>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>

          <aside className="col-span-1 space-y-5">
            {agent.themes && agent.themes.length > 0 ? (
              <section>
                <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
                  What this agent knows about
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {agent.themes.map((t) => (
                    <span
                      key={t}
                      className="inline-flex items-center h-6 px-2 rounded text-xs bg-secondary text-foreground/85"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </section>
            ) : null}

            {recentSessions.length > 0 ? (
              <section>
                <div className="flex items-baseline justify-between mb-3">
                  <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Recent sessions
                  </h3>
                  <span className="text-[10px] text-muted-foreground">All</span>
                </div>
                <ul className="space-y-1">
                  {recentSessions.map((s, i) => {
                    const { Icon, className, spin } = SESSION_STATUS_ICON[s.status];
                    const cls =
                      "flex items-center gap-2 px-2 py-2 -mx-2 rounded hover:bg-secondary/40 transition-colors";
                    const href = s.short_id ? `/sessions/${s.short_id}` : "/sessions/sess_3a8c";
                    return (
                      <li key={i}>
                        <Link href={href} className={cls}>
                          <Icon
                            className={cn(
                              "h-3 w-3 shrink-0",
                              className,
                              spin && "animate-spin-slow",
                            )}
                          />
                          <span className="text-xs flex-1 truncate">{s.title}</span>
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {s.age}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}

            {meshHints.length > 0 ? (
              <section>
                <div className="flex items-baseline justify-between mb-3">
                  <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    When it doesn&rsquo;t know
                  </h3>
                  <Link
                    href="/mesh"
                    className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Mesh →
                  </Link>
                </div>
                <div className="rounded-lg bg-secondary/40 p-3 text-xs leading-relaxed">
                  <p className="text-muted-foreground">Outgoing asks last 7d:</p>
                  <ul className="mt-2 space-y-1.5">
                    {meshHints.map((h, i) => (
                      <li key={i} className="flex items-baseline gap-2">
                        <ArrowUpRight className="h-3 w-3 text-muted-foreground shrink-0 self-center" />
                        <span className="font-mono text-foreground">{h.target}</span>
                        <span className="text-muted-foreground flex-1 truncate">— {h.intent}</span>
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {h.age}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            ) : (
              <section className="rounded-lg border border-dashed border-border p-4 text-center">
                <div className="text-xs text-muted-foreground">No outstanding mesh asks</div>
              </section>
            )}
          </aside>
        </div>

        <div className="mt-10 pt-6 border-t border-border text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2">
          <ClickToCopyId id={agent.id.replace(/^[a-z]+_/, "")} />
          <span className="text-border">·</span>
          <span>
            Created <span className="text-foreground">{formatRelativeTime(agent.created_at)}</span>
          </span>
          {parent ? (
            <>
              <span className="text-border">·</span>
              <span>
                parent{" "}
                <Link
                  href={`/agents/${parent.id}`}
                  className="text-foreground/70 hover:text-foreground font-mono"
                >
                  {parent.name}
                </Link>
              </span>
            </>
          ) : null}
          {agent.runtime ? (
            <>
              <span className="text-border">·</span>
              <span>
                runtime <span className="font-mono">{agent.runtime}</span>
              </span>
            </>
          ) : null}
          {agent.review_policy ? (
            <>
              <span className="text-border">·</span>
              <span>
                review policy <span className="font-mono">{agent.review_policy}</span>
              </span>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FactOriginIcon({ origin }: { origin?: MergeOrigin }) {
  if (origin === "merged") {
    return <GitMerge className="h-3.5 w-3.5 text-status-running shrink-0 mt-0.5" />;
  }
  if (origin === "promoted") {
    return <TrendingUp className="h-3.5 w-3.5 text-hier-team shrink-0 mt-0.5" />;
  }
  return <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />;
}

function factMetaLabel(
  origin: MergeOrigin | undefined,
  promotedFrom: string | undefined,
  sessionCount: number,
  createdAt: Date,
): string {
  const sessionPart =
    sessionCount === 1 ? "1 session" : `${sessionCount} sessions`;
  const time = formatRelativeTime(createdAt);
  if (origin === "merged") return `merged · ${sessionPart} · ${time}`;
  if (origin === "promoted") return `promoted from ${promotedFrom ?? "ic"} · ${sessionPart} · ${time}`;
  return `${sessionPart} · ${time}`;
}
