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
 * The *other* 500 handler, for routers that answer with a per-operation
 * error code and no message.
 *
 * `runtime/router`, `repo-runs`, `learned-skills`, `capabilities` and
 * `find-repo` wrote out the same three lines at the end of 18 handlers —
 * log `[<router>/<op>]`, then `res.status(500).json({ error: "<something>_failed" })`.
 * They deliberately do not use {@link makeErrorHandler}: these endpoints
 * return a bare machine-readable code and keep `err.message` in the logs,
 * where `makeErrorHandler` reflects the message back to the client. Both
 * shapes are in the wire contract already, so this factors out the second
 * one rather than collapsing it into the first.
 *
 * `op` and `code` are separate parameters because the code is not derivable
 * from the operation: `repo-runs/get` answers `get_failed`, but
 * `runtime/skills` answers `skills_read_failed` and
 * `capabilities/referenced-repos` answers `scan_failed`. Clients may branch
 * on these, so — as with `requireParam`'s `errorCode` — this factors out the
 * shape, not the codes.
 */
export function makeCodedErrorHandler(
  tag: string,
): (err: unknown, res: Response, op: string, code: string) => void {
  return (err, res, op, code) => {
    console.error(`[${tag}/${op}]`, err);
    res.status(500).json({ error: code });
  };
}

/** A domain error class, as passed to {@link makeServiceErrorHandler}. */
type ServiceErrorClass = abstract new (...args: never[]) => Error;

/** One `instanceof` → HTTP-status/error-code mapping. */
export interface ServiceErrorRule {
  /** Domain error class to match with `instanceof`. */
  error: ServiceErrorClass;
  status: number;
  /** Wire error code, e.g. `"task_not_found"`. */
  code: string;
}

/**
 * A `makeErrorHandler` that first maps known domain errors onto their HTTP
 * status.
 *
 * `task`, `escalation` and `negotiation` each hand-wrote the same shape: a
 * chain of `if (err instanceof SomeDomainError) { res.status(N).json({ error,
 * message: err.message }); return; }` ending in a byte-identical copy of the
 * `makeErrorHandler` body. The chain is the part that legitimately differs
 * per router (different error classes, different codes); the tail is not, and
 * having it written out three more times meant the generic-500 envelope lived
 * in seven places instead of one.
 *
 * Rules are tried in order, so a subclass must be listed before its base.
 * Anything unmatched falls through to `makeErrorHandler(tag)` — same log tag,
 * same `internal_error` envelope, same reflected `err.message`.
 */
export function makeServiceErrorHandler(
  tag: string,
  rules: readonly ServiceErrorRule[],
): (err: unknown, res: Response) => void {
  const fallback = makeErrorHandler(tag);
  return (err, res) => {
    for (const rule of rules) {
      if (err instanceof rule.error) {
        res.status(rule.status).json({ error: rule.code, message: err.message });
        return;
      }
    }
    fallback(err, res);
  };
}
