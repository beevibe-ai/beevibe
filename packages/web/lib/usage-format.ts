import type { SessionUsageDisplay } from "@/lib/types/sessions";

/**
 * Shared display vocabulary for cost / token / cache-hit telemetry.
 *
 * Lives in `lib/` so neither the dashboard usage section nor the
 * per-session usage panel cross-imports from the other's component
 * module. (Pre-consolidation, `usage-section.tsx` imported formatters
 * from `usage-panel.tsx` — that direction was a leaky abstraction.)
 */

export type StatusTone = "muted" | "review" | "done" | "failed";

const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  muted: "text-muted-foreground",
  review: "text-status-review",
  done: "text-status-done",
  failed: "text-status-failed",
};

/** Resolve a StatusTone to its Tailwind text-color class. */
export function statusToneClass(tone: StatusTone): string {
  return STATUS_TONE_CLASS[tone];
}

/**
 * Cost formatter — 4 decimal places to be transparent about token
 * billing. Sub-tenth-cent costs render as `<$0.0001` to avoid the
 * misleading `$0.0000` for a session that actually spent something.
 */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0.0000";
  if (usd < 0.0001) return "<$0.0001";
  return `$${usd.toFixed(4)}`;
}

/**
 * Cache-hit formatter — integer percent. Em-dash when there's no
 * input to score against (a zero ratio against zero input is N/A,
 * not a failure).
 */
export function formatCacheHit(usage: SessionUsageDisplay): string {
  if (usage.total_input_tokens === 0) return "—";
  return `${Math.round(usage.cache_hit_ratio * 100)}%`;
}

/**
 * Cache-hit tone — calibrated against the M9.8 warm-session target
 * (>0.7). Returns "muted" when there's nothing to score so the
 * headline doesn't read as red on an N/A condition.
 */
export function cacheHitTone(usage: SessionUsageDisplay): StatusTone {
  if (usage.total_input_tokens === 0) return "muted";
  if (usage.cache_hit_ratio >= 0.7) return "done";
  if (usage.cache_hit_ratio >= 0.4) return "review";
  return "failed";
}

/**
 * Token-count formatter — compact for large numbers, raw for small.
 * `13498` → `13.5K`, `2_350_000` → `2.35M`.
 */
export function formatTokens(n: number): string {
  if (n < 1000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
