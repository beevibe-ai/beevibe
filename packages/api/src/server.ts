import express, {
  json,
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import type { Server } from "node:http";
import type { LookupApiKeyDeps } from "@beevibe/core/auth";
import { createAuthMiddleware } from "./auth/middleware.js";
import { healthRoute } from "./routes/health.js";

/** Default 5-minute socket timeout. Covers `negotiate` rounds (each ~60-120s). */
export const DEFAULT_SOCKET_TIMEOUT_MS = 5 * 60_000;

export interface BeevibeApiServerConfig {
  port: number;
  authDeps: LookupApiKeyDeps;
  /** Override the default socket timeout. Default 5 min. */
  socketTimeoutMs?: number;
  /**
   * Origins allowed to make cross-origin requests with credentials. Used by
   * the web frontend during local dev (api on `:3000`, Next on `:3001+`)
   * and by remote-tunnel deployments where the web origin differs from
   * the api origin. Empty array disables CORS entirely (same-origin only).
   * Default: localhost ports 3000-3010 for dev convenience.
   */
  corsOrigins?: string[];
  /**
   * Origin regex patterns to allow in addition to `corsOrigins`. Used
   * for demo deployments where the web origin is a dynamic tunnel URL
   * (e.g. `*.trycloudflare.com`) and we don't know the exact host
   * ahead of time. Matched against the full origin string.
   */
  corsOriginPatterns?: RegExp[];
}

const DEFAULT_CORS_ORIGINS = Array.from({ length: 11 }, (_, i) => [
  `http://localhost:${3000 + i}`,
  `http://127.0.0.1:${3000 + i}`,
]).flat();

/**
 * Default origin patterns — accept demo tunnel URLs (cloudflared
 * trycloudflare + ngrok free tier) so `pnpm dev --tunnel` works
 * without needing the exact dynamic hostname known at boot. Production
 * deploys with a stable origin should pass an explicit `corsOrigins`
 * list and clear `corsOriginPatterns`.
 */
const DEFAULT_CORS_ORIGIN_PATTERNS: RegExp[] = [
  /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/,
  /^https:\/\/[a-z0-9-]+\.ngrok-free\.app$/,
];

const API_LANDING_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>beevibe api</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 640px; margin: 64px auto; padding: 0 24px; color: #09090b; line-height: 1.6; }
      h1 { font-size: 1.25rem; margin: 0 0 4px; }
      p { margin: 12px 0; color: #52525b; }
      code, kbd { font-family: ui-monospace, Menlo, monospace; background: #f4f4f5; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
      a { color: #09090b; }
    </style>
  </head>
  <body>
    <h1>beevibe api</h1>
    <p>This is the api server. It serves JSON over <code>Authorization: Bearer bv_u_…</code>; there's no webpage here.</p>
    <p>For the chat UI, run <code>pnpm --filter @beevibe/web dev</code> and open the URL it prints (typically <a href="http://localhost:3001">http://localhost:3001</a>).</p>
    <p>Health probe: <a href="/health"><code>/health</code></a>.</p>
  </body>
</html>`;

/**
 * Minimal CORS handler — no extra dependency. Echoes the request's Origin
 * back (matched against the allowlist) and answers OPTIONS preflights.
 * `Authorization` is exposed as an allowed header so EventSource + bv_u_
 * Bearer flows work cross-origin.
 */
function corsMiddleware(allowed: string[], patterns: RegExp[]): RequestHandler {
  if (allowed.length === 0 && patterns.length === 0) {
    return (_req, _res, next) => next();
  }
  const allowSet = new Set(allowed);
  const matches = (origin: string): boolean =>
    allowSet.has(origin) || patterns.some((re) => re.test(origin));
  return (req: Request, res: Response, next): void => {
    const origin = req.header("origin");
    if (origin && matches(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * The HTTP server. M6.1 ships the skeleton:
 *   - public `/health`
 *   - Bearer auth middleware factory exposed to subsequent milestones
 *   - 5-min socket timeout (lower than old repo's 10 min because escalation
 *     resolution is non-blocking — see M6.4)
 *
 * Subsequent milestones (M6.2 mcp routes, M6.3 hierarchy tools, M6.4 mesh +
 * REST + escalation) extend `app` via the methods exposed here.
 */
export class BeevibeApiServer {
  private readonly app: Express;
  private readonly authMiddleware: RequestHandler;
  private readonly socketTimeoutMs: number;
  private server?: Server;

  constructor(private readonly config: BeevibeApiServerConfig) {
    this.app = express();
    // CORS must run before json() so OPTIONS preflights are answered
    // without trying to parse a body.
    this.app.use(
      corsMiddleware(
        config.corsOrigins ?? DEFAULT_CORS_ORIGINS,
        config.corsOriginPatterns ?? DEFAULT_CORS_ORIGIN_PATTERNS,
      ),
    );
    this.app.use(json());

    this.authMiddleware = createAuthMiddleware(config.authDeps);
    this.socketTimeoutMs = config.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;

    // Public routes
    this.app.get("/health", healthRoute);
    // Friendly landing page at `/` — first-time users sometimes open the
    // api port (3000) in a browser instead of the web port (3001) and
    // get a confusing `{error: "missing_authorization"}` JSON response
    // from the auth middleware on a downstream router. This handler
    // points them at the web instead.
    this.app.get("/", (_req, res) => {
      res.type("text/html").send(API_LANDING_HTML);
    });
  }

  /** Reference to the underlying Express app for tests + subsequent milestones. */
  getApp(): Express {
    return this.app;
  }

  /** Bearer-auth middleware. Subsequent milestones mount it on protected routes. */
  getAuthMiddleware(): RequestHandler {
    return this.authMiddleware;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.config.port, () => {
        if (this.server) {
          this.server.setTimeout(this.socketTimeoutMs);
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
