import type { Request, Response } from "express";

/**
 * Read a required route param, 400-ing when Express hands back an empty
 * string.
 *
 * A `:id` segment can't normally be absent — the route wouldn't have
 * matched — but `req.params.id` is typed `string | undefined` under
 * `noUncheckedIndexedAccess`, so all 26 handlers that take a param grew
 * the same five-line preamble to narrow it. The `errorCode` stays
 * per-call-site because the codes already in the wire contract are not
 * uniform (`missing_id`, `missing_task_id`, `missing_agent_id`, …) and
 * clients may branch on them; this factors out the shape, not the codes.
 *
 * Returns `undefined` after responding, so the caller's next line is
 * `if (!id) return;` — the same guard convention as `requireHuman`.
 */
export function requireParam(
  req: Request,
  res: Response,
  name: string,
  errorCode: string,
): string | undefined {
  // Express 5 types a params value as `string | string[]`. A single
  // `:name` segment is always a string at runtime; narrow rather than
  // cast so a future repeated-segment route can't slip an array past
  // handlers that expect a string.
  const value = req.params[name];
  if (typeof value !== "string" || !value) {
    res.status(400).json({ error: errorCode });
    return undefined;
  }
  return value;
}

/**
 * The 400 a handler returns when the request body doesn't typecheck.
 *
 * Six handlers across `view`, `learned-skills` and `me` wrote out the
 * same `res.status(400).json({ error: "invalid_body", message })`. The
 * `message` stays a parameter rather than being derived: the wording is
 * not uniform (`view` describes the expected shape, `learned-skills`
 * lists the missing fields) and it is the only part a client sees, so
 * this factors out the envelope, not the prose.
 */
export function invalidBody(res: Response, message: string): void {
  res.status(400).json({ error: "invalid_body", message });
}

/**
 * Read a body field that accepts either an explicit `null` (clear the
 * value) or a non-empty string (set it), 400-ing on anything else —
 * absent, empty string, wrong type.
 *
 * `view`'s `/agent/:id/runtime` and `/agent/:id/model` are the same
 * nullable-string patch endpoint over different columns, and each had
 * spelled the three-way ternary out by hand. The distinction that makes
 * it fiddly is that `null` is a *valid* value here while `undefined`
 * means "reject" — inverted from the usual falsy check, and easy to get
 * subtly wrong when written twice.
 *
 * Returns `undefined` after responding, so the caller's next line is
 * `if (value === undefined) return;` — note the explicit compare, since
 * a returned `null` is success.
 */
export function requireNullableString(
  req: Request,
  res: Response,
  field: string,
): string | null | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const raw = body?.[field];
  if (raw === null) return null;
  if (typeof raw === "string" && raw) return raw;
  invalidBody(res, `expected { ${field}: string | null }`);
  return undefined;
}

/**
 * Load an entity and gate it on the caller owning it: 404 when it
 * doesn't exist, 403 when it belongs to somebody else.
 *
 * Eight handlers across `view`, `learned-skills` and `runtimes` spelled
 * this out inline — fetch, `if (!row) 404`, `if (row.owner !== caller)
 * 403` — which is eight chances to forget the second half. Forgetting it
 * is a cross-tenant read, so it's worth having one implementation that
 * can't be half-written.
 *
 * `ownerOf` is a projector rather than a fixed field name because the
 * column isn't uniform: agents and learned skills use `owner_id`,
 * daemons use `owner_person_id`.
 *
 * `notOwner` defaults to the usual 403 `not_owner`. `runtimes` overrides
 * it with its own 404 — that endpoint deliberately answers non-owners
 * with the not-found shape so it doesn't confirm that a daemon id
 * exists. Spelling the status out keeps that an explicit choice at the
 * call site rather than something inferred from the error code.
 *
 * Returns `undefined` after responding, so the caller's next line is
 * `if (!row) return;`.
 */
export async function loadOwned<T>(
  res: Response,
  personId: string,
  load: () => Promise<T | null | undefined>,
  ownerOf: (entity: T) => string | null | undefined,
  notFoundError: string,
  notOwner: { status: number; error: string } = { status: 403, error: "not_owner" },
): Promise<T | undefined> {
  const entity = await load();
  if (!entity) {
    res.status(404).json({ error: notFoundError });
    return undefined;
  }
  if (ownerOf(entity) !== personId) {
    res.status(notOwner.status).json({ error: notOwner.error });
    return undefined;
  }
  return entity;
}

/**
 * The 500 handler every route router grew its own copy of.
 *
 * `signin`, `signup`, `room` and `view` each defined a byte-identical (bar the
 * log tag) `handleError`: log the error server-side, then return a 500 whose
 * `message` is the error's own message. Four copies meant four places to
 * change if the error envelope ever moves.
 *
 * `context` is optional so the two shapes in use both survive verbatim:
 * routers with one handler for the whole file log `[room route]`, while `view`
 * — which has 23 call sites across six resources — passes a per-call context
 * and logs `[view route: task detail]`.
 *
 * NOTE: this reflects raw `err.message` back to the client, which is what all
 * four routers already did. `routes/chat.ts` deliberately does NOT — it
 * returns a generic message plus a `request_id` and keeps the detail in the
 * logs. That is a real divergence in what we expose, not an accident of
 * copy-paste, so chat keeps its own handler and this factory preserves the
 * existing behavior of the other four rather than quietly changing it.
 */
export function makeErrorHandler(
  tag: string,
): (err: unknown, res: Response, context?: string) => void {
  return (err, res, context) => {
    console.error(context ? `[${tag}: ${context}]` : `[${tag}]`, err);
    res.status(500).json({
      error: "internal_error",
      message: err instanceof Error ? err.message : String(err),
    });
  };
}

/**
 * One row of a service-error → HTTP-response table. `is` is the domain
 * error class to match with `instanceof`; the response carries `error` as
 * the stable code and the thrown error's own `message`.
 */
export interface ServiceErrorMapping {
  is: abstract new (...args: never[]) => Error;
  status: number;
  error: string;
}

/**
 * The catch-block every service-backed router grew its own copy of: walk a
 * short `instanceof` chain of the domain errors that map to a 4xx, and fall
 * through to {@link makeErrorHandler}'s 500 for anything unrecognized.
 *
 * `task`, `escalation` and `negotiation` each hand-rolled this — three
 * chains that differed only in their rows, sharing a byte-identical 500
 * tail. Splitting the table (data) from the walk (behavior) means a new
 * mapped error is one row rather than another chain, and the unmapped case
 * can't drift between routers.
 *
 * Deliberately NOT applied to `view`'s handlers: those mix domain-error
 * mapping with per-endpoint 404s of their own and pass a `context` string
 * through to the log tag, which this signature doesn't take.
 */
export function makeServiceErrorHandler(
  tag: string,
  mappings: readonly ServiceErrorMapping[],
): (err: unknown, res: Response) => void {
  const fallback = makeErrorHandler(tag);
  return (err, res) => {
    for (const mapping of mappings) {
      if (err instanceof mapping.is) {
        res.status(mapping.status).json({ error: mapping.error, message: err.message });
        return;
      }
    }
    fallback(err, res);
  };
}

/**
 * Read an integer query param, falling back when it is absent or unusable.
 *
 * Seven handlers across `view` and `find-repo` had each written out their
 * own `typeof req.query.x === "string" ? Number(...) : …` plus a range
 * check, and the range checks were not written the same way twice. The two
 * out-of-range policies actually in use both survive here as an explicit
 * `onOutOfRange` choice rather than an accident of how the ternary was
 * spelled:
 *
 * - `"fallback"` (default) — a value outside [min, max] is discarded and
 *   `fallback` is used. What `/inbox` (50, ≤200) and `/activity` (20, ≤100)
 *   already did.
 * - `"clamp"` — a value outside the range is pulled to the nearest bound
 *   and floored. What `/find-repo` (5, clamped to [1, 10]) already did.
 *
 * With no `fallback` the result is `undefined` for an absent or non-numeric
 * value, which is how `/promotion` and `/memory/fact` pass "unset" down to
 * the view layer.
 */
export interface IntQueryOptions {
  fallback?: number;
  min?: number;
  max?: number;
  onOutOfRange?: "fallback" | "clamp";
}

export function readIntQuery(
  req: Request,
  name: string,
  opts: IntQueryOptions & { fallback: number },
): number;
export function readIntQuery(req: Request, name: string, opts?: IntQueryOptions): number | undefined;
export function readIntQuery(
  req: Request,
  name: string,
  opts: IntQueryOptions = {},
): number | undefined {
  const raw = req.query[name];
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return opts.fallback;

  const min = opts.min ?? -Infinity;
  const max = opts.max ?? Infinity;
  // Clamping callers want an integer index, so floor before the range test
  // — `?limit=3.7` under [1, 10] is in range and must still come back as 3,
  // which is what /find-repo's Math.floor(Math.min(...)) already produced.
  const value = opts.onOutOfRange === "clamp" ? Math.floor(parsed) : parsed;
  if (value >= min && value <= max) return value;

  return opts.onOutOfRange === "clamp" ? Math.min(max, Math.max(min, value)) : opts.fallback;
}

/**
 * Read a trimmed string query param, or `""` when absent, empty, or not a
 * string — so the caller's next line is a plain `if (!value)` 400.
 *
 * Express types a query value as `string | string[] | ParsedQs | …` (a
 * repeated `?goal=a&goal=b` really does arrive as an array), and
 * `/find-repo`'s `goal` and `/capabilities`' `task_id` each narrowed it
 * with the same hand-written ternary before trimming. The other query
 * params in this package deliberately keep `undefined` for "absent" rather
 * than folding it into `""`, so they are left alone.
 */
export function readStringQuery(req: Request, name: string): string {
  const raw = req.query[name];
  return typeof raw === "string" ? raw.trim() : "";
}
