import express, { json, type Express, type RequestHandler } from "express";
import { createServer, type Server } from "node:http";
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
 *
 * Phase 4 (daemon-first restructure): owns the underlying `http.Server` (not
 * just the Express app) so the daemon WSS upgrade handler can attach to it
 * without re-creating the listener.
 */
export class BeevibeApiServer {
  private readonly app: Express;
  private readonly httpServer: Server;
  private readonly authMiddleware: RequestHandler;
  private readonly socketTimeoutMs: number;
  private listening = false;

  constructor(private readonly config: BeevibeApiServerConfig) {
    this.app = express();
    this.app.use(json());

    this.authMiddleware = createAuthMiddleware(config.authDeps);
    this.socketTimeoutMs = config.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS;

    // Public routes
    this.app.get("/health", healthRoute);

    this.httpServer = createServer(this.app);
  }

  /** Reference to the underlying Express app for tests + subsequent milestones. */
  getApp(): Express {
    return this.app;
  }

  /** Underlying http.Server — exposed for WS upgrade handlers (Phase 4). */
  getHttpServer(): Server {
    return this.httpServer;
  }

  /** Bearer-auth middleware. Subsequent milestones mount it on protected routes. */
  getAuthMiddleware(): RequestHandler {
    return this.authMiddleware;
  }

  async start(): Promise<void> {
    if (this.listening) return;
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, () => {
        this.httpServer.setTimeout(this.socketTimeoutMs);
        this.listening = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.listening) return;
    return new Promise((resolve, reject) => {
      this.httpServer.close((err) => {
        this.listening = false;
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
