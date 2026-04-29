import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { LookupApiKeyDeps, ResolvedCaller } from "@beevibe/core/auth";
import { lookupApiKey } from "@beevibe/core/auth";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      caller?: ResolvedCaller;
    }
  }
}

const BEARER_PATTERN = /^Bearer\s+(.+)$/;

/**
 * Express middleware that resolves the `Authorization: Bearer <token>` header
 * to a `ResolvedCaller` via M4's `lookupApiKey`, attaching it to `req.caller`.
 *
 * 401 cases:
 *   - missing Authorization header
 *   - malformed (not `Bearer <token>` shape)
 *   - token resolves to no caller (unknown agent / unknown person / person
 *     without primary agent)
 *
 * Downstream handlers can rely on `req.caller` being defined when reached.
 */
export function createAuthMiddleware(deps: LookupApiKeyDeps): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.headers.authorization;
    if (!auth) {
      res.status(401).json({
        error: "missing_authorization",
        message: "Authorization header required",
      });
      return;
    }

    const match = BEARER_PATTERN.exec(auth);
    if (!match) {
      res.status(401).json({
        error: "malformed_authorization",
        message: "Expected: Authorization: Bearer <token>",
      });
      return;
    }

    const token = (match[1] ?? "").trim();
    const caller = await lookupApiKey(deps, token);
    if (!caller) {
      res.status(401).json({
        error: "invalid_token",
        message: "Token does not resolve to a valid caller",
      });
      return;
    }

    req.caller = caller;
    next();
  };
}
