import type { Request } from "express";

/**
 * Reading a number off `req.query`.
 *
 * Five handlers across `view` and `find-repo` spelled out the same
 * `typeof req.query.x === "string" ? Number(req.query.x) : <default>` and
 * then disagreed on what to do next — two dropped an out-of-band value,
 * two swapped it for the default, one clamped it, and none of them agreed
 * on whether `NaN` was the caller's problem or Postgres'. The parsing half
 * is identical in all five; only the out-of-band policy differs, so that
 * is what stays at the call site.
 */

/**
 * Read a numeric query param.
 *
 * Returns `fallback` when the param is absent, repeated (Express hands
 * back an array), non-numeric, or — when `min`/`max` are given — outside
 * the band. Omit `fallback` for the handlers that pass `undefined` down to
 * a view that owns the default.
 *
 * Out-of-band values resolve to `fallback` rather than clamping, which is
 * what `/inbox` and `/activity` already did. Callers that want the other
 * policy compose with `clampInt`: `clampInt(numericQuery(req, "limit"),
 * { min: 1, max: 10, fallback: 5 })`.
 */
export function numericQuery(
  req: Request,
  name: string,
  bounds: { min?: number; max?: number; fallback?: number } = {},
): number | undefined {
  const raw = req.query[name];
  if (typeof raw !== "string") return bounds.fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return bounds.fallback;
  if (bounds.min !== undefined && value < bounds.min) return bounds.fallback;
  if (bounds.max !== undefined && value > bounds.max) return bounds.fallback;
  return value;
}
