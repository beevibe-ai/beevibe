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
 * Pure adapter: copy `?token=` query into the `Authorization: Bearer ...`
 * header so downstream auth middleware (which only reads the header) can
 * handle EventSource requests. EventSource can't set custom headers, so
 * `/api/stream` accepts the token via query. Header takes precedence
 * when both are present.
 *
 * Tokens-in-URLs are normally a leak risk (logged by proxies), but the
 * stream payload is just `{event, id}` — no secrets, and the leaked
 * URL would be re-captured on every reload anyway.
 *
 * Used in two places: as the front of `createStreamAuthMiddleware` for
 * the stream router's own auth, AND mounted by bootstrap at `/api/stream`
 * ahead of viewRouter's root-mounted header-only auth so that auth
 * doesn't 401 the request before the stream router sees it.
 */
export const streamTokenAdapter: RequestHandler = (req, _res, next) => {
  if (!req.headers.authorization && typeof req.query.token === "string") {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
};

export function createStreamAuthMiddleware(deps: LookupApiKeyDeps): RequestHandler {
  const inner = createAuthMiddleware(deps);
  return (req, res, next) => {
    streamTokenAdapter(req, res, () => inner(req, res, next));
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

/** Express request narrowed to a confirmed daemon (`bv_d_`) caller. */
export type DaemonRequest = Request & {
  caller: Extract<ResolvedCaller, { source: "daemon" }>;
};

/**
 * Type guard for the /runtime/* surface. Sends 403 on non-daemon callers;
 * returns true and narrows `req` to `DaemonRequest` on success. The auth
 * middleware already attached `req.caller`; this just gates by source.
 */
export function requireDaemon(req: Request, res: Response): req is DaemonRequest {
  if (req.caller?.source !== "daemon") {
    res.status(403).json({
      error: "daemon_required",
      message: "this endpoint requires a bv_d_ token",
    });
    return false;
  }
  return true;
}
