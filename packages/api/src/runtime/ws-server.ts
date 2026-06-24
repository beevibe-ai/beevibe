/**
 * WSS upgrade handler for /runtime/ws.
 *
 * Pattern: shared http.Server with Express; this module hooks the
 * 'upgrade' event for path /runtime/ws only and lets every other upgrade
 * pass through. Bearer auth on the upgrade request gates entry — only
 * resolved bv_d_ daemon callers proceed; everyone else gets a 401 close.
 *
 * Heartbeat: server pings every 30s; if a pong doesn't arrive before the
 * NEXT ping, the socket is terminated. Keeps the dedup cache in the hub
 * accurate against zombies behind dropped TCP.
 */

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { LookupApiKeyDeps } from "@beevibe/core/auth";
import { lookupApiKey } from "@beevibe/core/auth";
import type { RuntimeRepository, SessionRepository } from "@beevibe/core";
import type { DaemonClient, DaemonHub, DaemonPushPayload } from "./hub.js";

export const RUNTIME_WS_PATH = "/runtime/ws";

export interface RuntimeWsServerOptions {
  hub: DaemonHub;
  authDeps: LookupApiKeyDeps;
  runtimeRepo: RuntimeRepository;
  /**
   * Used for replay-on-connect: after a daemon's WS upgrade succeeds we
   * fire a one-shot query for `status='pending'` sessions on the
   * subscribed runtimes and push a wakeup for each. Closes the silent-
   * loss window when the previous socket was half-open and missed pushes
   * fired between dispatch and the server's ping-watchdog terminating
   * the zombie.
   */
  sessionRepo: Pick<SessionRepository, "listPendingForRuntimeIds">;
  /** Default 30_000 ms. */
  pingIntervalMs?: number;
}

interface DaemonWsClient extends DaemonClient {
  ws: WebSocket;
  alive: boolean;
}

const BEARER_PATTERN = /^Bearer\s+(.+)$/;
const DEFAULT_PING_INTERVAL_MS = 30_000;
// Cap on pending sessions replayed per WS upgrade. A misconfigured
// runtime with a queue of thousands of stuck rows shouldn't fan out a
// huge per-client send burst on every reconnect; the daemon polls every
// 30s anyway so the tail catches up. We warn when the cap actually
// bites so silent truncation is observable.
const REPLAY_PENDING_MAX = 500;

export class RuntimeWsServer {
  private readonly wss: WebSocketServer;
  private readonly pingIntervalMs: number;
  private readonly pingTimers = new Map<DaemonWsClient, ReturnType<typeof setInterval>>();
  private boundHandler?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private boundServer?: Server;

  constructor(private readonly options: RuntimeWsServerOptions) {
    this.wss = new WebSocketServer({ noServer: true });
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  }

  attach(httpServer: Server): void {
    if (this.boundHandler) throw new Error("RuntimeWsServer already attached");
    this.boundHandler = (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    };
    this.boundServer = httpServer;
    httpServer.on("upgrade", this.boundHandler);
  }

  /** Drop all clients and detach from the http server. */
  async stop(): Promise<void> {
    if (this.boundHandler && this.boundServer) {
      this.boundServer.off("upgrade", this.boundHandler);
      this.boundHandler = undefined;
      this.boundServer = undefined;
    }
    for (const timer of this.pingTimers.values()) clearInterval(timer);
    this.pingTimers.clear();
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
      for (const ws of this.wss.clients) ws.terminate();
    });
  }

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== RUNTIME_WS_PATH) return; // not ours; let other handlers pick it up

    const auth = req.headers.authorization;
    const match = auth ? BEARER_PATTERN.exec(auth) : null;
    if (!match) return abort(socket, 401, "missing_bearer");

    const caller = await lookupApiKey(this.options.authDeps, (match[1] ?? "").trim());
    if (!caller || caller.source !== "daemon") {
      return abort(socket, 401, "invalid_token");
    }

    const runtimeIdsParam = url.searchParams.get("runtime_ids");
    if (!runtimeIdsParam) return abort(socket, 400, "missing_runtime_ids");
    const runtimeIds = runtimeIdsParam.split(",").map((s) => s.trim()).filter(Boolean);
    if (runtimeIds.length === 0) return abort(socket, 400, "missing_runtime_ids");

    const runtimes = await Promise.all(
      runtimeIds.map((rid) => this.options.runtimeRepo.findById(rid)),
    );
    for (const runtime of runtimes) {
      if (!runtime || runtime.daemon_id !== caller.daemonId) {
        return abort(socket, 403, "runtime_not_owned");
      }
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnect(ws, caller.daemonId, runtimeIds);
    });
  }

  private onConnect(ws: WebSocket, daemonId: string, runtimeIds: string[]): void {
    const client: DaemonWsClient = {
      daemonId,
      runtimeIds,
      ws,
      alive: true,
      send: (payload: DaemonPushPayload) => {
        ws.send(JSON.stringify(payload));
      },
    };
    this.options.hub.register(client);
    // Bump last_heartbeat so the DB trigger fires `runtime.updated` SSE and
    // the web's online dot flips immediately, not after the next ~30s HTTP
    // heartbeat / React Query staleTime window.
    void this.touchHeartbeats(runtimeIds);
    // Replay any sessions pushed (or that should have been) while the
    // daemon's previous socket was half-open. Targets this client only —
    // sibling subscribers stayed connected and already saw those pushes,
    // so going through hub.notify would just burn their dedup slots.
    void this.replayPending(client, runtimeIds);
    ws.on("pong", () => {
      client.alive = true;
    });

    const timer = setInterval(() => {
      if (!client.alive) {
        ws.terminate();
        return;
      }
      client.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, this.pingIntervalMs);
    this.pingTimers.set(client, timer);

    const cleanup = () => {
      clearInterval(timer);
      this.pingTimers.delete(client);
      this.options.hub.unregister(client);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  private async replayPending(
    client: DaemonClient,
    runtimeIds: readonly string[],
  ): Promise<void> {
    try {
      const pending = await this.options.sessionRepo.listPendingForRuntimeIds(
        [...runtimeIds],
        REPLAY_PENDING_MAX,
      );
      if (pending.length >= REPLAY_PENDING_MAX) {
        console.warn("[runtime/ws] replay-pending hit cap; tail relies on 30s daemon poll", {
          cap: REPLAY_PENDING_MAX,
          daemonId: client.daemonId,
        });
      }
      for (const row of pending) {
        client.send({
          type: "task_available",
          runtime_id: row.runtime_id,
          session_id: row.id,
        });
      }
    } catch (err) {
      console.warn("[runtime/ws] replay-pending failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async touchHeartbeats(runtimeIds: readonly string[]): Promise<void> {
    await Promise.all(
      runtimeIds.map(async (rid) => {
        try {
          await this.options.runtimeRepo.heartbeat(rid);
        } catch (err) {
          console.warn("[runtime/ws] heartbeat on connect failed", {
            runtimeId: rid,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }
}

function abort(socket: Duplex, status: number, reason: string): void {
  // Minimal HTTP error response body so curl/operators can see what failed
  // without parsing WS frames; the daemon sees this as upgrade failure.
  socket.write(
    `HTTP/1.1 ${status} ${statusText(status)}\r\n` +
      "Content-Type: application/json\r\n" +
      "Connection: close\r\n\r\n" +
      `{"error":"${reason}"}`,
  );
  socket.destroy();
}

function statusText(code: number): string {
  if (code === 401) return "Unauthorized";
  if (code === 403) return "Forbidden";
  if (code === 400) return "Bad Request";
  return "Error";
}
