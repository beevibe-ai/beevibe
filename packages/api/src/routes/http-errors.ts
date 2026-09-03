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
 * Shape check for an email address in a request body.
 *
 * `signin` and `signup` each carried a byte-identical copy of this
 * regex. They are the two halves of one credential flow, so a drift
 * between them is worse than the usual duplication: tightening one side
 * alone would let a visitor create an account at an address they then
 * can't sign in with (or vice versa). Deliberately permissive — it
 * rejects obvious junk, and delivery is the real check.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Read and normalize a body `email`, 400-ing when it's absent or
 * malformed.
 *
 * Normalization (trim + lowercase) is part of the contract rather than
 * the caller's job: `personRepo.findByEmail` does an exact match, so
 * signup storing `Foo@Bar.com` while signin looks up `foo@bar.com` would
 * be an account the owner can't reach. Both routes already lowercased —
 * this makes it impossible for one of them to stop.
 *
 * Returns `undefined` after responding, so the caller's next line is
 * `if (!email) return;` — the same guard convention as `requireParam`.
 */
export function requireEmail(req: Request, res: Response): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const raw = body?.email;
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!email || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "invalid_email", message: "valid email required" });
    return undefined;
  }
  return email;
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
