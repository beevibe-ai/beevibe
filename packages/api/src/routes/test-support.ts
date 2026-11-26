import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Auth middleware stand-in for the route suites.
 *
 * Five route tests (`repo-runs`, `me`, `learned-skills`, `room`, `view`)
 * each defined the same `stubAuth`: hand the router a middleware that
 * pins `req.caller` to a human, to an agent, or leaves it unset so the
 * real `requireHuman` / `requireAgent` guards reject. Three of the five
 * were byte-identical; the other two differed only in which agent id
 * constant they closed over.
 *
 * The ids are bound once per suite so the returned `stubAuth(source)`
 * keeps the exact call shape all five already used — including the
 * `"human"` default, which three of them relied on.
 *
 * `hierarchyLevel` is not a parameter: every suite used `"team"` for the
 * human caller and `"ic"` for the agent caller. A suite that needs a
 * different level should say so explicitly rather than widen this.
 */
export function makeStubAuth(ids: { agentId: string; personId: string }) {
  return (source: "human" | "agent" | "none" = "human"): RequestHandler =>
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
