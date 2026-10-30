/**
 * Server-side formatters used by the views layer to produce
 * display-ready fields (`short_id`, `duration_label`, `elapsed`).
 *
 * The shared ones now live in `@beevibe/core`'s domain layer, where the
 * web app reads the same implementation — these used to be a parallel
 * copy of `packages/web/lib/format.ts`, kept in sync by comment. The
 * re-exports below keep this package's existing import sites working
 * and keep the api's own naming (`formatRelativeShort` for the
 * suffix-less form the wire uses).
 */

import { formatRelative, type DateLike } from "@beevibe/core/domain/format";

export {
  deriveShortId,
  firstNonEmptyLine,
  formatDurationLabel,
  truncate,
} from "@beevibe/core/domain/format";

/** Relative-time label like "just now" / "2m" / "1h" / "3d". */
export function formatRelativeShort(date: DateLike, now: Date = new Date()): string {
  return formatRelative(date, { now });
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
 * Resolve a list view's `limit` filter against its own bounds: the caller's
 * value when given, otherwise `fallback`, clamped into `1..max`.
 *
 * Every paginated view did this inline with the same
 * `Math.min(Math.max(1, limit ?? DEFAULT), MAX)` expression and its own pair
 * of bound constants. The bounds stay per-view — a memory-facts page and an
 * inbox page cap at genuinely different sizes — but the clamp is one rule.
 *
 * Exactly equivalent to the expression it replaces, non-integer and
 * non-finite inputs included. Those don't arise today: the /view routes
 * already drop a non-finite `?limit=` to `undefined` before calling in, so
 * this layer never sees one. Tightening the contract here (truncating a
 * fractional limit, or treating 0 as "unspecified" rather than as 1) would
 * be a behaviour change, not a de-duplication — left for its own commit.
 */
export function clampListLimit(limit: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(1, limit ?? fallback), max);
}
