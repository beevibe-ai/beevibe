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
}

const DEFAULT_CORS_ORIGINS = Array.from({ length: 11 }, (_, i) => [
  `http://localhost:${3000 + i}`,
  `http://127.0.0.1:${3000 + i}`,
]).flat();

/**
 * Minimal CORS handler — no extra dependency. Echoes the request's Origin
 * back (matched against the allowlist) and answers OPTIONS preflights.
 * `Authorization` is exposed as an allowed header so EventSource + bv_u_
 * Bearer flows work cross-origin.
 */
function corsMiddleware(allowed: string[]): RequestHandler {
  if (allowed.length === 0) {
    return (_req, _res, next) => next();
  }
  const allowSet = new Set(allowed);
  return (req: Request, res: Response, next): void => {
    const origin = req.header("origin");
    if (origin && allowSet.has(origin)) {
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
    this.app.use(corsMiddleware(config.corsOrigins ?? DEFAULT_CORS_ORIGINS));
    this.app.use(json());

    this.authMiddleware = createAuthMiddleware(config.authDeps);
    this.socketTimeoutMs = config.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;

    // Public routes
    this.app.get("/health", healthRoute);
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
