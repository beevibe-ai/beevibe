/**
 * The one bounded-integer guard behind every `LIMIT $n` and window size
 * this package hands to Postgres.
 *
 * `promotions`, `inbox` and `memory` each wrote `Math.min(Math.max(1,
 * filter.limit ?? DEFAULT), MAX)` inline, and `memory-activity` carried a
 * private `clampInt` that did the same job properly. Three of the four
 * copies never truncated, so a fractional `?limit=1.5` reached pg as
 * `LIMIT '1.5'` and came back a 500 instead of a page of rows.
 */

/**
 * Coerce a caller-supplied number into `[min, max]`.
 *
 * `undefined`, `NaN` and `±Infinity` all resolve to `fallback` — those are
 * "no usable value", not "a value at the edge". A usable value is
 * truncated toward zero (a row count has to be an integer for pg) and then
 * clamped.
 *
 * `belowMin` is explicit because the two families of call site genuinely
 * disagree and both behaviors are pinned by tests. A `limit` under the
 * minimum means "as few as possible", so it clamps to `min` — that is what
 * `?limit=0` has always returned. A `weeks` window under the minimum is
 * treated as garbage input and falls back to the default window, because a
 * one-week trend chart is a worse answer than the default one. Neither is
 * wrong; the point is that the choice is now visible in one place instead
 * of being implied by two different implementations.
 */
export function clampInt(
  value: number | undefined,
  opts: {
    min: number;
    max: number;
    fallback: number;
    belowMin?: "clamp" | "fallback";
  },
): number {
  const { min, max, fallback, belowMin = "clamp" } = opts;
  if (value === undefined || !Number.isFinite(value)) return fallback;
  if (belowMin === "fallback" && value < min) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
