/**
 * Shared fixtures for the route-layer tests.
 *
 * `routes/{room,view,repo-runs,learned-skills,me}.test.ts` each carried a
 * copy of the same 15-line `stubAuth`: an Express middleware that attaches
 * a `human` caller (team tier), an `agent` caller (ic tier), or nothing at
 * all, so a test can exercise a router's auth gates without the real
 * Bearer-token lookup. The five copies differed only in which agent and
 * person id they hard-coded, so only the ids are a parameter here.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

/** Which caller shape to attach — `"none"` leaves `req.caller` unset. */
export type StubCallerSource = "human" | "agent" | "none";

/**
 * Bind the stub to one test file's fixture ids, then call the result the
 * way the local copies were called: `stubAuth()` for a human caller,
 * `stubAuth("agent")` / `stubAuth("none")` for the other two.
 */
export function makeStubAuth(ids: {
  agentId: string;
  personId: string;
}): (source?: StubCallerSource) => RequestHandler {
  return (source: StubCallerSource = "human") =>
    (req: Request, _res: Response, next: NextFunction) => {
      if (source === "human") {
        req.caller = {
          source: "human",
          agentId: ids.agentId,
          hierarchyLevel: "team",
          personId: ids.personId,
        };
      } else if (source === "agent") {
        req.caller = { source: "agent", agentId: ids.agentId, hierarchyLevel: "ic" };
      }
      next();
    };
}
