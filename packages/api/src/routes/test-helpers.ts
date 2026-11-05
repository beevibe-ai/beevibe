/**
 * Shared fixtures for the route-level unit tests.
 *
 * Every `routes/*.test.ts` mounts its router on a bare express app behind
 * a fake auth middleware, and five of them had grown a byte-identical
 * (or ids-aside identical) local `stubAuth` plus the same four-line
 * `makeApp` preamble. Both live here now so a change to `ResolvedCaller`
 * is one edit rather than five.
 */

import express, { json, type Express, type RequestHandler, type Router } from "express";

/**
 * Which kind of caller the stub attaches. `"none"` attaches nothing —
 * the shape a request with no (or an unresolvable) token arrives in, so
 * routes' 401/403 branches can be exercised.
 */
export type StubCallerSource = "human" | "agent" | "none";

export interface StubAuthOptions {
  /** Agent id on the attached caller. */
  agentId?: string;
  /** Person id on the attached caller. Ignored for `"agent"`. */
  personId?: string;
}

const DEFAULT_AGENT_ID = "agent_a";
const DEFAULT_PERSON_ID = "person_1";

/**
 * Stand-in for `createAuthMiddleware` that attaches a caller without
 * touching the DB.
 *
 * A `"human"` caller is attached at `hierarchyLevel: "team"` and an
 * `"agent"` caller at `"ic"` — the combination the route tests assume,
 * since the human surface is the one that owns a top-level team agent
 * while spawned sessions run as ICs. Pass ids when the test asserts on
 * a specific one; the defaults suit tests that only care about the
 * source.
 */
export function stubAuth(
  source: StubCallerSource = "human",
  opts: StubAuthOptions = {},
): RequestHandler {
  const agentId = opts.agentId ?? DEFAULT_AGENT_ID;
  const personId = opts.personId ?? DEFAULT_PERSON_ID;
  return (req, _res, next) => {
    if (source === "human") {
      req.caller = { source: "human", agentId, hierarchyLevel: "team", personId };
    } else if (source === "agent") {
      req.caller = { source: "agent", agentId, hierarchyLevel: "ic" };
    }
    next();
  };
}

/**
 * Mount one router on a fresh express app with JSON body parsing — the
 * preamble every route test's `makeApp` opens with. Tests keep their own
 * `makeApp` for the dependency wiring, which is per-router and not
 * shareable; this is only the express part.
 */
export function mountRouter(path: string, router: Router): Express {
  const app = express();
  app.use(json());
  app.use(path, router);
  return app;
}
