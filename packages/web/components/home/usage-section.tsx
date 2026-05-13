import { ArrowDown, ArrowUp, CircleDollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatCost,
  formatTokens,
} from "@/components/sessions/usage-panel";
import type {
  UsageAgentBreakdown,
  UsageSummaryData,
} from "@/lib/types/dashboard";

/**
 * Dashboard "Usage" section — surfaces the cost + token rollup the
 * backend ships in `dashboard.usage_summary`. Designed to slot into
 * the home page alongside the existing KPI tiles + status / fleet /
 * trend blocks; visual language matches `KpiTile` (label on top,
 * large tabular value below, small meta line).
 *
 * Layout:
 *   - Section heading "Usage" with a window-length subtitle.
 *   - 4-up tile row: cost (with delta arrow), tokens, cache hit,
 *     sessions. Cost delta tone is inverted relative to "good": an
 *     INCREASE in cost is bad (red), a decrease is good (green).
 *   - Per-agent breakdown bars below — horizontal bars where width
 *     is proportional to the top spender's cost. Shows top 5; if
 *     more exist, surfaces a "+N more" footer.
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
          totalInput={
            summary.total_input_tokens +
            summary.total_cache_creation_tokens +
            summary.total_cache_read_tokens
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

// ── tiles ─────────────────────────────────────────────────────────────

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
  tone?: "done" | "review" | "failed" | "muted";
}) {
  const toneClass =
    tone === "done"
      ? "text-status-done"
      : tone === "review"
        ? "text-status-review"
        : tone === "failed"
          ? "text-status-failed"
          : tone === "muted"
            ? "text-muted-foreground"
            : "";
  return (
    <div
      className={cn(
        "text-3xl font-semibold tabular-nums leading-none",
        toneClass,
      )}
    >
      {children}
    </div>
  );
}

function TileMeta({ children }: { children: React.ReactNode }) {
  return <div className="mt-2 text-xs text-muted-foreground">{children}</div>;
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
  // Inverted tone: cost UP is bad, cost DOWN is good. Zero-prior-zero
  // current renders as a flat "—" so we don't paint a false-positive
  // green "down" on an empty window.
  const flat = priorCost === 0 && cost === 0;
  const arrow = flat ? null : deltaPercent > 0 ? "up" : deltaPercent < 0 ? "down" : null;
  const tone: "failed" | "done" | "muted" = flat
    ? "muted"
    : deltaPercent > 0
      ? "failed"
      : deltaPercent < 0
        ? "done"
        : "muted";
  return (
    <div>
      <TileLabel>cost (usd)</TileLabel>
      <TileValue>{formatCost(cost)}</TileValue>
      <TileMeta>
        {flat ? (
          "—"
        ) : (
          <span className={cn("inline-flex items-center gap-0.5", toneClassFor(tone))}>
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
  // Headline: input + output (the billed-bytes-shaped pair). Meta:
  // breakdown of the cache slices so the absolute cost picture is
  // visible without opening individual sessions.
  const billed = input + output;
  return (
    <div>
      <TileLabel>tokens</TileLabel>
      <TileValue>{formatTokens(billed)}</TileValue>
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

function CacheHitTile({
  ratio,
  totalInput,
}: {
  ratio: number;
  totalInput: number;
}) {
  if (totalInput === 0) {
    return (
      <div>
        <TileLabel>cache hit</TileLabel>
        <TileValue tone="muted">—</TileValue>
        <TileMeta>no input in window</TileMeta>
      </div>
    );
  }
  const pct = Math.round(ratio * 100);
  const tone: "done" | "review" | "failed" =
    ratio >= 0.7 ? "done" : ratio >= 0.4 ? "review" : "failed";
  return (
    <div>
      <TileLabel>cache hit</TileLabel>
      <TileValue tone={tone}>{pct}%</TileValue>
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

function toneClassFor(tone: "done" | "review" | "failed" | "muted"): string {
  if (tone === "done") return "text-status-done";
  if (tone === "review") return "text-status-review";
  if (tone === "failed") return "text-status-failed";
  return "text-muted-foreground";
}

// ── per-agent breakdown ──────────────────────────────────────────────

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
  // Bar width proportional to the highest-cost agent — visually scaled
  // for the bar group, not for the dashboard at large. With only one
  // agent (or all-zero), every bar shows full-width which still reads
  // as a single dominant entry.
  const max = top.reduce((m, a) => Math.max(m, a.cost_usd), 0);
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
