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

/**
 * SSE-friendly auth wrapper. Browsers using `EventSource` cannot set a
 * custom `Authorization` header, so the `/api/stream` route accepts the
 * token via `?token=` query as well. If the header is already present
 * (Authorization: Bearer ...) it takes precedence.
 *
 * Tokens-in-URLs are normally a leak risk (logged by proxies), but the
 * stream payload is just `{event, id}` — no secrets, and the leaked
 * URL would be re-captured on every reload anyway.
 */
export function createStreamAuthMiddleware(deps: LookupApiKeyDeps): RequestHandler {
  const inner = createAuthMiddleware(deps);
  return (req, res, next) => {
    if (!req.headers.authorization && typeof req.query.token === "string") {
      req.headers.authorization = `Bearer ${req.query.token}`;
    }
    inner(req, res, next);
  };
}

/** Express request narrowed to a confirmed human (`bv_u_`) caller. */
export type HumanRequest = Request & {
  caller: Extract<ResolvedCaller, { source: "human" }>;
};

/**
 * Type guard for routes that only accept human callers (e.g., the REST
 * endpoints under /task and /escalation). Sends 403 to the response and
 * returns false on agent / missing callers; returns true and narrows
 * `req` to `HumanRequest` on success. The auth middleware already
 * attached `req.caller`; this just gates by source.
 */
export function requireHuman(req: Request, res: Response): req is HumanRequest {
  if (req.caller?.source !== "human") {
    res.status(403).json({
      error: "human_required",
      message: "this endpoint requires a bv_u_ token",
    });
    return false;
  }
  return true;
}
