/**
 * The page-size guard the list views share.
 *
 * `listInbox`, `listMemoryFacts` and `listPromotions` each opened with
 * a byte-identical `Math.min(Math.max(1, filter.limit ?? DEFAULT), MAX)`.
 * Each is the last thing standing between a caller-supplied number and
 * a SQL `LIMIT`, which is the argument for there being one of them
 * rather than three.
 *
 * The route layer has its own readers in `routes/query-params.ts`; the
 * two halves are deliberately separate, because `/inbox` and
 * `/activity` reject an out-of-band limit at the route (sending it back
 * to the default) while `/promotion` and `/memory/fact` pass the raw
 * number down to here and let it be clamped to the nearest bound. Both
 * policies are pinned by tests.
 */

/**
 * Clamp a caller-supplied page size into `[1, max]`, substituting
 * `fallback` when they passed nothing at all.
 *
 * Deliberately does not truncate: a fractional `limit` reaches Postgres
 * today and is rounded there, and nothing depends on either behavior,
 * so this preserves the existing one rather than changing it inside a
 * refactor.
 */
export function clampLimit(
  limit: number | undefined,
  opts: { fallback: number; max: number },
): number {
  return Math.min(Math.max(1, limit ?? opts.fallback), opts.max);
}
