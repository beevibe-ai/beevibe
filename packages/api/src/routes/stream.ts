/**
 * SSE live-update route — `GET /api/stream`. Browsers use this to receive
 * `bv_event` notifications fanned out by `SseManager` and invalidate
 * React Query caches.
 *
 * Auth: bv_u_ via `Authorization: Bearer` header OR `?token=` query
 * (since `EventSource` can't set custom headers).
 *
 * Heartbeat: a comment line every 25s keeps proxies (nginx, cloudflared)
 * from idling-out the connection. Browser reconnects automatically.
 */

import { Router, type RequestHandler } from "express";
import { requireHuman } from "../auth/middleware.js";
import type { BvEvent, SseManager } from "../sse/manager.js";

const HEARTBEAT_INTERVAL_MS = 25_000;

export interface StreamRoutesDeps {
  authMiddleware: RequestHandler;
  sseManager: SseManager;
}

export function createStreamRouter(deps: StreamRoutesDeps): Router {
  const router = Router();
  router.use(deps.authMiddleware);

  router.get("/stream", (req, res) => {
    if (!requireHuman(req, res)) return;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const send = (event: BvEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Register with the caller's personId — SseManager only invokes this
    // callback for events owned by this person (per OwnerLookup), so two
    // users on the same process never see each other's task / agent /
    // session activity.
    const unsubscribe = deps.sseManager.subscribe(req.caller.personId, send);
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, HEARTBEAT_INTERVAL_MS);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  return router;
}
