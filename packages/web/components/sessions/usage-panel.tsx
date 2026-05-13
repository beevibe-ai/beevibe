import { CircleDollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SessionUsageDisplay } from "@/lib/types/sessions";

/**
 * Per-session cost + token usage panel. Tiered visual hierarchy per
 * the team's UI preference (no flat property lists for dense data —
 * the eye should land on the load-bearing numbers first):
 *
 *   Tier 1 (headline, large): cost + cache hit ratio
 *     The two numbers a human reviewing a session actually needs to
 *     decide "was this expensive?" / "was the cache working?"
 *
 *   Tier 2 (secondary, mid): four-cell token breakdown
 *     Input / Output / Cache write / Cache read — the substrate the
 *     headline numbers derive from. Mono font + tabular nums so the
 *     digits align in the grid.
 *
 *   Tier 3 (tertiary, muted): model name
 *     Useful for debugging "why did this cost what it did" but
 *     visually quiet — most sessions use one model.
 *
 * Cache-hit color bands are calibrated against the M9.8 target of
 * >0.7 on a warm second-onward session. Green/amber/red is the
 * standard semantic so they read at a glance.
 */
export function UsagePanel({ usage }: { usage: SessionUsageDisplay }) {
  return (
    <section
      className="mt-8 pt-5 border-t border-border/60"
      aria-label="Session usage"
    >
      <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4 flex items-center gap-1.5">
        <CircleDollarSign className="h-3 w-3" />
        Usage
      </h2>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <Headline label="cost" value={formatCost(usage.cost_usd)} />
        <Headline
          label="cache hit"
          value={formatCacheHit(usage)}
          tone={cacheHitTone(usage)}
        />
      </div>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2 text-xs border-t border-border/40 pt-3">
        <TokenStat label="Input" value={usage.input_tokens} />
        <TokenStat label="Output" value={usage.output_tokens} />
        <TokenStat label="Cache write" value={usage.cache_creation_tokens} />
        <TokenStat label="Cache read" value={usage.cache_read_tokens} />
      </dl>

      <div className="mt-3 text-[11px] text-muted-foreground/60 font-mono">
        {usage.model}
      </div>
    </section>
  );
}

function Headline({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
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
            : "text-foreground";
  return (
    <div>
      <div className={cn("text-2xl font-semibold tabular-nums", toneClass)}>
        {value}
      </div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function TokenStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground/85 tabular-nums font-mono">
        {formatTokens(value)}
      </dd>
    </div>
  );
}

// ── formatters ────────────────────────────────────────────────────────

/**
 * Cost formatter — 4 decimal places to be transparent about token
 * billing (most session costs land in the $0.0010–$0.5000 range; 2
 * decimals would round most things to $0.00). Sub-cent sessions
 * render as `<$0.0001` to avoid a misleading $0.0000.
 */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0.0000";
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(4)}`;
}

/**
 * Cache-hit formatter — integer percent for readability. When the
 * session processed no input at all (`total_input_tokens === 0`),
 * show an em-dash instead of "0%" — a zero ratio against zero input
 * is meaningless, not bad.
 */
export function formatCacheHit(usage: SessionUsageDisplay): string {
  if (usage.total_input_tokens === 0) return "—";
  return `${Math.round(usage.cache_hit_ratio * 100)}%`;
}

/**
 * Cache-hit tone — green/amber/red per M9.8 calibration. Returns
 * `"muted"` when there's no input to score against so the headline
 * doesn't read as red on an N/A condition.
 */
export function cacheHitTone(
  usage: SessionUsageDisplay,
): "done" | "review" | "failed" | "muted" {
  if (usage.total_input_tokens === 0) return "muted";
  if (usage.cache_hit_ratio >= 0.7) return "done";
  if (usage.cache_hit_ratio >= 0.4) return "review";
  return "failed";
}

/**
 * Token-count formatter — compact for large numbers, raw for small.
 * `13498` → `13.5K`, `619` → `619`. Keeps the grid scannable at a
 * glance; the raw count is one click away in the network response.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
