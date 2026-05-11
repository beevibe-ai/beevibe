/**
 * CORS hardening — origin allowlist for cross-origin browser requests.
 *
 * For the current phases the api is reached only from localhost — the
 * web dev server (`http://localhost:3001+`) and any other dev tooling.
 * Hosted deployments will land in the auto-deploy phase (after Phase 6
 * daemon distribution) and add their public origins via env at that
 * point. There is intentionally NO blanket "allow tunnel origin"
 * support: cloudflared / ngrok URLs leak easily and CORS is a
 * trust-boundary check.
 *
 * Allowed origins:
 *   - any `http://localhost:<port>` or `http://127.0.0.1:<port>`
 *   - exact origins listed in BEEVIBE_CORS_ORIGINS (comma-separated env)
 *
 * Server placement: the middleware MUST be `app.use(...)` BEFORE
 * `express.json()` and BEFORE the auth middleware. Preflight (OPTIONS)
 * requests carry no body and no Authorization header by spec; running
 * either of those before CORS would 400 / 401 the preflight and the
 * browser would never send the real request.
 *
 * Allow-Credentials is set to `true` because the SSE EventSource on
 * the web side opens with `withCredentials: true`. That requires a
 * specific (non-wildcard) Access-Control-Allow-Origin per the CORS
 * spec — the middleware echoes the request's Origin only after
 * checking it against the allowlist, so this is safe.
 */

import type { Request, RequestHandler, Response } from "express";

const LOCALHOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const DEFAULT_HEADERS = ["Authorization", "Content-Type"] as const;
const DEFAULT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const DEFAULT_MAX_AGE_SECONDS = 86_400;

export interface CorsConfig {
  /**
   * Extra origins to allow beyond the localhost defaults. Exact-match
   * only; no wildcards. Typical deployment populates this from
   * BEEVIBE_CORS_ORIGINS via `parseAllowedOrigins`.
   */
  allowedOrigins?: readonly string[];
  /** Default `Authorization, Content-Type`. */
  allowedHeaders?: readonly string[];
  /** Default `GET, POST, PUT, PATCH, DELETE, OPTIONS`. */
  allowedMethods?: readonly string[];
  /** Preflight-cache TTL in seconds. Default 86400 (1 day). */
  maxAgeSeconds?: number;
}

export function isAllowedOrigin(
  origin: string,
  configured: readonly string[],
): boolean {
  if (LOCALHOST_PATTERN.test(origin)) return true;
  return configured.includes(origin);
}

export function createCorsMiddleware(config: CorsConfig = {}): RequestHandler {
  const allowedHeadersValue = (config.allowedHeaders ?? DEFAULT_HEADERS).join(", ");
  const allowedMethodsValue = (config.allowedMethods ?? DEFAULT_METHODS).join(", ");
  const maxAgeValue = String(config.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS);
  const configuredOrigins = config.allowedOrigins ?? [];

  return function corsMiddleware(req: Request, res: Response, next): void {
    const originHeader = req.headers.origin;
    const origin = typeof originHeader === "string" ? originHeader : undefined;

    // Same-origin (no Origin header on the request) — pass through.
    // OPTIONS without an Origin is a non-CORS preflight (rare); answer
    // 204 since most apps want OPTIONS to be a no-op.
    if (!origin) {
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
      return;
    }

    if (isAllowedOrigin(origin, configuredOrigins)) {
      // Echo back the specific origin (not `*`) — required when
      // Allow-Credentials is true.
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", allowedHeadersValue);
      res.setHeader("Access-Control-Allow-Methods", allowedMethodsValue);
      res.setHeader("Access-Control-Max-Age", maxAgeValue);
      // Caches must key on Origin so a wrong-origin response from this
      // path can't be served back to a later allowed-origin request.
      res.setHeader("Vary", "Origin");
    }

    if (req.method === "OPTIONS") {
      // Preflight: 204 either way. Browser only proceeds to the real
      // request when it sees a matching Allow-Origin.
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Comma-split env value into a clean list of origins. Empty entries dropped. */
export function parseAllowedOrigins(env: string | undefined): string[] {
  if (!env) return [];
  return env
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
