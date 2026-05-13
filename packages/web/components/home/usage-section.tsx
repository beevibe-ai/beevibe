import { ArrowDown, ArrowUp, CircleDollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatCost,
  formatTokens,
  statusToneClass,
  type StatusTone,
} from "@/lib/usage-format";
import type {
  UsageAgentBreakdown,
  UsageSummaryData,
} from "@/lib/types/dashboard";

/**
 * Dashboard "Usage" section. 4-up KPI tile row + per-agent cost bars.
 * Visual language matches `KpiTile` so the section reads as part of
 * the same dashboard family.
 */
export function DashboardUsageSection({
  summary,
}: {
  summary: UsageSummaryData;
}) {
  return (
    <section
      className="mt-10 pt-8 border-t border-border/60"
      aria-label="Usage"
    >
      <header className="mb-5 flex items-baseline justify-between gap-4">
        <h2 className="text-base font-semibold tracking-tight flex items-center gap-2">
          <CircleDollarSign className="h-4 w-4 text-muted-foreground" />
          Usage
        </h2>
        <span className="text-xs text-muted-foreground">
          last {summary.window_days} days
        </span>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-6 mb-8">
        <CostTile
          cost={summary.total_cost_usd}
          deltaPercent={summary.cost_change_percent}
          priorCost={summary.prior_cost_usd}
        />
        <TokensTile
          input={summary.total_input_tokens}
          output={summary.total_output_tokens}
          cacheCreation={summary.total_cache_creation_tokens}
          cacheRead={summary.total_cache_read_tokens}
        />
        <CacheHitTile
          ratio={summary.cache_hit_ratio}
          hasInput={
            summary.total_input_tokens +
              summary.total_cache_creation_tokens +
              summary.total_cache_read_tokens >
            0
          }
        />
        <SessionsTile count={summary.total_sessions} />
      </div>

      {summary.per_agent.length > 0 ? (
        <AgentBreakdown agents={summary.per_agent} totalCost={summary.total_cost_usd} />
      ) : (
        <p className="text-xs text-muted-foreground italic">
          No agent sessions in this window.
        </p>
      )}
    </section>
  );
}

function TileLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
      {children}
    </div>
  );
}

function TileValue({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div
      className={cn(
        "text-3xl font-semibold tabular-nums leading-none",
        tone ? statusToneClass(tone) : undefined,
      )}
    >
      {children}
    </div>
  );
}

function TileMeta({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 text-xs text-muted-foreground">{children}</div>;
}

/**
 * Cost delta semantics, inverted vs the "good" convention: an INCREASE
 * in cost is bad (red), a decrease is good (green). Zero-prior-zero-
 * current is a flat em-dash so we don't paint a false-positive green
 * on an empty window.
 */
function costDelta(
  priorCost: number,
  cost: number,
  deltaPercent: number,
): { tone: StatusTone; arrow: "up" | "down" | null; flat: boolean } {
  const flat = priorCost === 0 && cost === 0;
  if (flat) return { tone: "muted", arrow: null, flat: true };
  if (deltaPercent > 0) return { tone: "failed", arrow: "up", flat: false };
  if (deltaPercent < 0) return { tone: "done", arrow: "down", flat: false };
  return { tone: "muted", arrow: null, flat: false };
}

function CostTile({
  cost,
  deltaPercent,
  priorCost,
}: {
  cost: number;
  deltaPercent: number;
  priorCost: number;
}) {
  const { tone, arrow, flat } = costDelta(priorCost, cost, deltaPercent);
  return (
    <div>
      <TileLabel>cost (usd)</TileLabel>
      <TileValue>{formatCost(cost)}</TileValue>
      <TileMeta>
        {flat ? (
          "—"
        ) : (
          <span className={cn("inline-flex items-center gap-0.5", statusToneClass(tone))}>
            {arrow === "up" ? <ArrowUp className="h-3 w-3" /> : null}
            {arrow === "down" ? <ArrowDown className="h-3 w-3" /> : null}
            <span className="tabular-nums">{Math.abs(deltaPercent)}%</span>
            <span className="text-muted-foreground"> vs prior</span>
          </span>
        )}
      </TileMeta>
    </div>
  );
}

function TokensTile({
  input,
  output,
  cacheCreation,
  cacheRead,
}: {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}) {
  return (
    <div>
      <TileLabel>tokens</TileLabel>
      <TileValue>{formatTokens(input + output)}</TileValue>
      <TileMeta>
        <span className="tabular-nums">{formatTokens(input)}</span> in ·{" "}
        <span className="tabular-nums">{formatTokens(output)}</span> out
        <br />
        cache: <span className="tabular-nums">{formatTokens(cacheCreation)}</span> w ·{" "}
        <span className="tabular-nums">{formatTokens(cacheRead)}</span> r
      </TileMeta>
    </div>
  );
}

function CacheHitTile({ ratio, hasInput }: { ratio: number; hasInput: boolean }) {
  if (!hasInput) {
    return (
      <div>
        <TileLabel>cache hit</TileLabel>
        <TileValue tone="muted">—</TileValue>
        <TileMeta>no input in window</TileMeta>
      </div>
    );
  }
  const tone: StatusTone = ratio >= 0.7 ? "done" : ratio >= 0.4 ? "review" : "failed";
  return (
    <div>
      <TileLabel>cache hit</TileLabel>
      <TileValue tone={tone}>{Math.round(ratio * 100)}%</TileValue>
      <TileMeta>target &gt; 70% on warm sessions</TileMeta>
    </div>
  );
}

function SessionsTile({ count }: { count: number }) {
  return (
    <div>
      <TileLabel>sessions</TileLabel>
      <TileValue>{count.toLocaleString("en-US")}</TileValue>
      <TileMeta>with usage telemetry</TileMeta>
    </div>
  );
}

const TOP_AGENTS = 5;

function AgentBreakdown({
  agents,
  totalCost,
}: {
  agents: UsageAgentBreakdown[];
  totalCost: number;
}) {
  const top = agents.slice(0, TOP_AGENTS);
  const overflow = agents.length - top.length;
  // SQL pre-sorts ORDER BY cost DESC, so the head row is the max.
  const max = top[0]?.cost_usd ?? 0;
  return (
    <div>
      <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
        by agent · top {top.length}
      </h3>
      <ul className="space-y-2">
        {top.map((a) => (
          <AgentBar
            key={a.agent_id}
            agent={a}
            widthPercent={max === 0 ? 0 : (a.cost_usd / max) * 100}
            totalCost={totalCost}
          />
        ))}
      </ul>
      {overflow > 0 ? (
        <div className="mt-3 text-[11px] text-muted-foreground">
          + {overflow} more agent{overflow === 1 ? "" : "s"}
        </div>
      ) : null}
    </div>
  );
}

function AgentBar({
  agent,
  widthPercent,
  totalCost,
}: {
  agent: UsageAgentBreakdown;
  widthPercent: number;
  totalCost: number;
}) {
  const sharePct = totalCost === 0 ? 0 : Math.round((agent.cost_usd / totalCost) * 100);
  return (
    <li className="flex items-center gap-3 text-sm">
      <span className="w-28 shrink-0 truncate text-foreground/85" title={agent.agent_label}>
        {agent.agent_label}
      </span>
      <div className="flex-1 min-w-0 h-2 rounded-sm bg-secondary/60 overflow-hidden">
        <div
          className="h-full bg-primary/70"
          style={{ width: `${widthPercent}%` }}
          aria-hidden
        />
      </div>
      <span className="shrink-0 w-20 text-right text-xs text-foreground/85 tabular-nums font-mono">
        {formatCost(agent.cost_usd)}
      </span>
      <span className="shrink-0 w-10 text-right text-[11px] text-muted-foreground tabular-nums">
        {sharePct}%
      </span>
      <span className="shrink-0 w-16 text-right text-[11px] text-muted-foreground tabular-nums">
        {agent.sessions}{" "}
        <span className="text-muted-foreground/60">
          sess{agent.sessions === 1 ? "" : "ions"}
        </span>
      </span>
    </li>
  );
}
