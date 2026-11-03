/**
 * Row-limit clamping for the caller-supplied `limit` that the view,
 * route and tool layers all accept.
 *
 * Five call sites had their own spelling of "default it, floor it at 1,
 * cap it at MAX": `views/inbox`, `views/memory` and `views/promotions`
 * were character-for-character identical, and `routes/find-repo` plus
 * `tools/find-repo` shared a one-line variant.
 *
 * Lives at the package root rather than under `views/` because it is used
 * from all three layers — the same reason `routes/http-errors.ts` sits
 * beside its routes and `tools/errors.ts` beside its tools.
 *
 * Two local clamps are deliberately NOT routed through here, because
 * their out-of-range behavior genuinely differs and quietly harmonizing
 * it would be a behavior change nobody asked for:
 *
 * - `views/memory-activity.ts`'s `clampInt` maps a below-minimum value to
 *   its *fallback* (`weeks: 0` → 12), not to the minimum.
 * - `adapters/postgres/session-search-repo.ts`'s `clamp` lives in core,
 *   has no fallback at all, and maps a non-finite value to the minimum.
 */

/**
 * Clamp an optional row limit into `[min, max]`, defaulting it when the
 * caller supplied nothing usable.
 *
 * `undefined` and any non-finite number (`NaN` from a `Number("abc")`
 * parse, `Infinity`) resolve to `fallback`. A fractional value is
 * truncated toward zero before clamping.
 *
 * Both of those were holes in the previous inline versions: the three
 * view copies ran `Math.min(Math.max(1, limit ?? DEFAULT), MAX)` with no
 * finiteness guard, so a `NaN` limit stayed `NaN` all the way into the
 * `LIMIT $n` binding, and a fractional one arrived as `LIMIT 2.7` —
 * Postgres rejects both. Callers that already filtered non-numbers
 * upstream see no change.
 *
 * @param value Caller-supplied limit, if any.
 * @param opts `fallback` applies when `value` is unusable; `min` defaults
 *   to 1, since every current caller's floor is one row.
 */
export function clampLimit(
  value: number | undefined,
  opts: { fallback: number; max: number; min?: number },
): number {
  const min = opts.min ?? 1;
  const base = value !== undefined && Number.isFinite(value) ? value : opts.fallback;
  return Math.min(Math.max(min, Math.trunc(base)), opts.max);
}
