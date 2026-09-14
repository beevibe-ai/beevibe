/**
 * One implementation of "how big a page did the caller ask for".
 *
 * Every list endpoint takes `?limit=`, and every one of them had spelled
 * out its own parse-and-bound by hand — nine copies across `routes/view`,
 * `routes/find-repo` and four `views/*` composers. They had drifted into
 * three different answers for the same input:
 *
 *   - `/view/promotion` and `/view/memory/fact` accepted any finite number
 *     and let the view clamp it.
 *   - `/view/inbox` and `/view/activity` fell back to the *default* when
 *     the number was out of band, so `?limit=201` quietly returned 50 rows
 *     rather than the 200 the caller could have had.
 *   - `/find-repo` and the three `views/*` clamps clamped to the band.
 *
 * Clamping is the behavior this settles on: it is what four of the six
 * sites already did, and "you asked for more than we serve, here is the
 * most we serve" beats silently dropping back to a smaller default.
 *
 * None of the copies floored, which is the bug the split hid: `?limit=1.5`
 * reached `LIMIT $n` as the string `1.5`, Postgres refused to parse it as a
 * bigint, and the endpoint 500ed. {@link clampLimit} floors, so every
 * endpoint now answers a fractional limit with rows instead of an error.
 *
 * The two halves are deliberately separate, because the layers need
 * different halves. A route reads an untyped query value and has no
 * business knowing a resource's page size ({@link parseLimit}); a
 * `views/*` composer owns the band because it owns the query's cost
 * ({@link clampLimit}), and is also called from places that never saw an
 * HTTP request. `/find-repo`, which has no view behind it, composes both.
 */

/** The band a resource serves: what an absent limit means, and the ceiling. */
export interface LimitBounds {
  /** Page size when the caller didn't ask for one (or asked unintelligibly). */
  fallback: number;
  /** Largest page the resource will serve. */
  max: number;
  /** Smallest page. Defaults to 1 — no endpoint here wants a 0-row page. */
  min?: number;
}

/**
 * Bound an already-numeric limit. `undefined` and non-finite values take
 * the fallback; everything else is floored into `[min, max]`.
 *
 * Idempotent, so it is safe for a caller to have bounded the value already.
 */
export function clampLimit(value: number | undefined, bounds: LimitBounds): number {
  const { fallback, max, min = 1 } = bounds;
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(min, Math.floor(value)), max);
}

/**
 * Read a raw `req.query.limit` into a number, or `undefined` when the
 * caller didn't give a usable one. Deciding what `undefined` means is the
 * band owner's job — pass the result to {@link clampLimit}, or straight to
 * a `views/*` composer whose `limit?` field does that for you.
 *
 * Express types a query value as `string | string[] | ParsedQs |
 * undefined`; anything that isn't a single string (a repeated
 * `?limit=1&limit=2`, a nested `?limit[a]=1`) is treated as absent rather
 * than coerced.
 *
 * A blank value (`?limit=` or `?limit=%20`) is absent too, not zero.
 * `Number("")` is 0, which is finite — so the old hand-written checks let
 * an empty param through as a real request for zero rows, and
 * `/view/promotion` answered `?limit=` with a single row. The fallback is
 * the only sensible reading of "the caller named the param and left it
 * empty".
 */
export function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}
