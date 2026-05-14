/**
 * Server-side formatters used by the views layer to produce display-ready
 * fields (`short_id`, `duration_label`, `elapsed`). Mirrors the logic in
 * `packages/web/lib/format.ts`. Defined here so the API can compute these
 * once and the web's format helpers stay in sync (drift will surface as a
 * mismatched `short_id` in the URL).
 */

/**
 * Strip the type prefix (`xxx_`) and take the first 6 chars. Matches
 * `packages/web/lib/format.ts:shortId`. Note: web prepends "#" for display
 * but the URL key is the raw 6-char string — that's what we return here.
 */
export function deriveShortId(id: string): string {
  const trimmed = id.replace(/^[a-z]+_/, "");
  return trimmed.slice(0, 6);
}

/** Relative-time label like "just now" / "2m" / "1h" / "3d". */
export function formatRelativeShort(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo`;
  return `${Math.floor(diffMonth / 12)}y`;
}

/**
 * Cache hit ratio against total input. Total input is the sum of all
 * three input slices per the `SessionUsage` contract — measuring
 * `cache_read / (input + cache_creation + cache_read)` is the correct
 * denominator (`cache_read / input` would always read >1× on a warm
 * second-onward session). Returns 0 when there's no input to score
 * against — caller decides whether to render that as 0% or N/A.
 */
export function computeCacheHitRatio(parts: {
  input: number;
  cacheCreation: number;
  cacheRead: number;
}): number {
  const total = parts.input + parts.cacheCreation + parts.cacheRead;
  return total > 0 ? parts.cacheRead / total : 0;
}

/**
 * Duration label between started_at and completed_at (or now if running).
 * Returns "—" if no start. Format: "2m", "1h 4m", "3d 2h", etc.
 */
export function formatDurationLabel(
  startedAt: Date | null | undefined,
  completedAt: Date | null | undefined,
  now: Date = new Date(),
): string {
  if (!startedAt) return "—";
  const end = completedAt ?? now;
  const diffSec = Math.max(0, Math.floor((end.getTime() - startedAt.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const mins = min % 60;
  if (hr < 24) return mins ? `${hr}h ${mins}m` : `${hr}h`;
  const days = Math.floor(hr / 24);
  const hrs = hr % 24;
  return hrs ? `${days}d ${hrs}h` : `${days}d`;
}

/**
 * First non-empty line of a multi-line block content. Used to derive a
 * one-liner UI headline (e.g. `specialization` from a core-memory
 * tag_line block) from text that might be empty / whitespace-only /
 * multi-line. Returns undefined when there is nothing renderable.
 */
export function firstNonEmptyLine(content: string | null | undefined): string | undefined {
  if (!content) return undefined;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
