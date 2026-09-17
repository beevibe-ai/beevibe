/**
 * Shared auth-middleware stub for route-layer unit tests. Replaces five
 * near-identical local `stubAuth` helpers across `routes/*.test.ts` —
 * three of them byte-for-byte, the other two differing only in which
 * agent-id constant they closed over.
 *
 * Same shape as `views/test-helpers.ts`, which did this for the view
 * tests' `makePool`.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Which caller the stub should install on the request.
 *
 * `"none"` leaves `req.caller` unset, standing in for a request whose
 * key didn't resolve — the route's own 401/403 handling is what those
 * cases are testing.
 *
 * `"daemon"` is deliberately absent: the daemon-authenticated surface
 * (`/runtime/*`) authenticates through a different middleware and none
 * of these five suites exercise it.
 */
export type StubCallerSource = "human" | "agent" | "none";

export interface StubAuthIdentity {
  /** `personId` for the human caller. Agent callers carry no person. */
  personId: string;
  /** `agentId` for both the human and agent callers. */
  agentId: string;
}

/**
 * Bind a stub to one suite's identity constants, returning the
 * `stubAuth(source)` the suites already call.
 *
 * `hierarchyLevel` is not a parameter because all five suites used the
 * same pairing — `"team"` for the human caller, `"ic"` for the agent —
 * and no test varies it. A suite that needs a different level should say
 * so explicitly rather than inheriting a default from here.
 */
export function makeStubAuth(identity: StubAuthIdentity) {
  return function stubAuth(source: StubCallerSource = "human"): RequestHandler {
    return (req: Request, _res: Response, next: NextFunction) => {
      if (source === "human") {
        req.caller = {
          source: "human",
          agentId: identity.agentId,
          hierarchyLevel: "team",
          personId: identity.personId,
        };
      } else if (source === "agent") {
        req.caller = { source: "agent", agentId: identity.agentId, hierarchyLevel: "ic" };
      }
      next();
    };
  };
}
