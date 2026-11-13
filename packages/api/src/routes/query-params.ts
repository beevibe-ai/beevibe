/**
 * Query-string readers for the REST routes.
 *
 * Companion to `http-errors.ts`, which does the same job for route
 * params (`:id`) and bodies. Express types every `req.query` value as
 * `string | string[] | ParsedQs | undefined`, so each handler that
 * reads one grew the same `typeof … === "string" ? … : fallback`
 * preamble — eight of them, in four different spellings of the same
 * intent.
 *
 * The spellings mattered, because the out-of-band policies behind them
 * are genuinely different and all three are pinned by tests:
 *
 *   - `/inbox` and `/activity` send anything outside the band back to
 *     the default (`?limit=201` → 50), via {@link boundedIntQuery}.
 *   - `/promotion` and `/memory/fact` pass the raw number straight
 *     through and let the view layer clamp it, via {@link numberQuery}.
 *   - `find_repo` clamps to the nearest bound rather than defaulting,
 *     and that clamp lives in the tool — see `tools/find-repo.ts`.
 *
 * So these helpers factor out the *reading*, and keep the policy an
 * explicit choice at the call site. Harmonizing the three policies
 * would be a wire-contract change, which this is not.
 */

import type { Request, Response } from "express";

/**
 * Raw string value of a query param, or `undefined` when absent or
 * repeated (`?x=1&x=2`, which Express hands back as an array).
 *
 * Does not trim — `/task`'s `lifecycle`, `view` and `assignee_id` are
 * matched against fixed sets or used verbatim, and trimming them would
 * start accepting `?view=%20mine`.
 */
export function stringQuery(req: Request, name: string): string | undefined {
  const raw = req.query[name];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * A trimmed, non-empty query param, 400-ing with `errorCode` on
 * anything else — absent, empty, whitespace-only, repeated.
 *
 * Returns `undefined` after responding, so the caller's next line is
 * `if (!value) return;` — the same guard convention as `requireParam`
 * and `requireHuman`.
 */
export function requireStringQuery(
  req: Request,
  res: Response,
  name: string,
  errorCode: string,
): string | undefined {
  const value = stringQuery(req, name)?.trim();
  if (!value) {
    res.status(400).json({ error: errorCode });
    return undefined;
  }
  return value;
}

/**
 * A finite number from a query param, or `undefined` when the param is
 * absent or doesn't parse.
 *
 * NOTE `Number("")` is `0`, which is finite, so `?limit=` reads as an
 * explicit zero rather than as absent. That is the existing behavior on
 * `/promotion` and `/memory/fact` (and is pinned by a test that calls
 * it out as "not endorsed"), so it is preserved here rather than
 * quietly fixed — these two routes let the view layer apply the lower
 * bound.
 */
export function numberQuery(req: Request, name: string): number | undefined {
  const raw = stringQuery(req, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * An integer query param required to land inside `[min, max]`, with
 * anything else — absent, non-numeric, out of band — falling back to
 * `fallback`.
 *
 * This is the `/inbox` (1..200, default 50) and `/activity` (1..100,
 * default 20) policy: a bad bound is treated as "caller didn't ask",
 * not clamped to the nearest edge. `min` defaults to 1 because a
 * zero-or-negative page size is never meaningful.
 */
export function boundedIntQuery(
  req: Request,
  name: string,
  opts: { max: number; fallback: number; min?: number },
): number {
  const { max, fallback, min = 1 } = opts;
  const n = numberQuery(req, name);
  if (n === undefined || n < min || n > max) return fallback;
  return n;
}

/**
 * A query param constrained to a known set of literals, `undefined`
 * when absent or unrecognized.
 *
 * `/task`'s `lifecycle` and `view` filters and `/memory/fact`'s `scope`
 * each spelled this out as a read, then a `Set.has` behind a cast. The
 * predicate form keeps the narrowing honest: the cast happens once,
 * here, guarded by the membership check.
 */
export function enumQuery<T extends string>(
  req: Request,
  name: string,
  allowed: ReadonlySet<T>,
): T | undefined {
  const raw = stringQuery(req, name);
  return raw !== undefined && allowed.has(raw as T) ? (raw as T) : undefined;
}

/**
 * An integer query param floored and clamped to the nearest bound,
 * falling back to `fallback` only when the param is absent or doesn't
 * parse as a number.
 *
 * The third of the three policies: `find_repo` answers `?limit=50` with
 * 10 rather than with its default, and `?limit=3.7` with 3. Both the
 * route and the tool's own handler assert this band — see the comment
 * at the call site for why that stays duplicated.
 */
export function boundedFloorIntQuery(
  req: Request,
  name: string,
  opts: { min: number; max: number; fallback: number },
): number {
  const n = numberQuery(req, name);
  if (n === undefined) return opts.fallback;
  return Math.min(opts.max, Math.max(opts.min, Math.floor(n)));
}
