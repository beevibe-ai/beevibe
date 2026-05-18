/**
 * Claim loop. Two triggers:
 *   1. Server WS push (`task_available`) — fast wake-up after dispatch.
 *   2. HTTP poll every 30s — correctness fallback if WS missed.
 *   3. Periodic heartbeat every 15s so the api can mark this runtime
 *      online for the Runtimes panel.
 *
 * For each trigger, the daemon attempts /runtime/claim per registered
 * runtime. A successful claim returns a dispatch payload which is
 * handed off to runDispatch() running concurrently inside the supervisor's
 * concurrency cap.
 */

import WebSocket from "ws";
import { RUNTIME_HEARTBEAT_INTERVAL_MS, type RuntimeRegistry } from "@beevibe/core";
import type { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import type { ApiClient } from "./api-client.js";
import type { Supervisor } from "./supervisor.js";
import { runDispatch, type DispatchPayload } from "./spawner.js";

export interface ClaimerConfig {
  api: ApiClient;
  supervisor: Supervisor;
  workspaceManager: LocalWorkspaceManager;
  runtimeRegistry: RuntimeRegistry;
  runtimeIds: string[];
  /** Default 30_000ms. */
  pollIntervalMs?: number;
  /** Default 15_000ms. */
  heartbeatIntervalMs?: number;
  /** Default 30_000ms — exponential backoff cap for WS reconnect. */
  wsReconnectMaxDelayMs?: number;
}

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_WS_RECONNECT_MAX_MS = 30_000;

interface PushPayload {
  type: "task_available" | "cancel";
  runtime_id?: string;
  session_id?: string;
}

export class Claimer {
  private running = false;
  private ws?: WebSocket;
  private pollTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer?: NodeJS.Timeout;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly wsReconnectMaxDelayMs: number;

  constructor(private readonly cfg: ClaimerConfig) {
    this.pollIntervalMs = cfg.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.heartbeatIntervalMs = cfg.heartbeatIntervalMs ?? RUNTIME_HEARTBEAT_INTERVAL_MS;
    this.wsReconnectMaxDelayMs =
      cfg.wsReconnectMaxDelayMs ?? DEFAULT_WS_RECONNECT_MAX_MS;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.heartbeat();
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat(),
      this.heartbeatIntervalMs,
    );

    void this.pollAll();
    this.pollTimer = setInterval(() => void this.pollAll(), this.pollIntervalMs);

    this.connectWs();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = undefined;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = undefined;
    }
    this.cfg.supervisor.cancelAll();
  }

  private connectWs(): void {
    if (!this.running) return;
    const ws = this.cfg.api.openWebSocket(this.cfg.runtimeIds);
    this.ws = ws;

    ws.on("open", () => {
      this.wsReconnectAttempts = 0;
      console.log(
        `[daemon] connected: ${this.cfg.runtimeIds.length} runtime(s) subscribed`,
      );
    });

    ws.on("message", (raw) => {
      let msg: PushPayload;
      try {
        msg = JSON.parse(raw.toString()) as PushPayload;
      } catch {
        return;
      }
      if (msg.type === "task_available" && msg.runtime_id) {
        // Best-effort wake-up; the next poll catches it anyway. Don't
        // race a parallel claim — just kick off this runtime's poll.
        void this.pollRuntime(msg.runtime_id);
      } else if (msg.type === "cancel" && msg.session_id) {
        this.cfg.supervisor.cancel(msg.session_id);
      }
    });

    ws.on("close", () => {
      if (!this.running) return;
      this.scheduleWsReconnect();
    });

    ws.on("error", (err) => {
      console.warn("[daemon] ws error:", err.message);
      // Triggers `close`; reconnect lives there.
    });
  }

  private scheduleWsReconnect(): void {
    if (!this.running) return;
    this.wsReconnectAttempts += 1;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped).
    const delay = Math.min(
      1_000 * Math.pow(2, this.wsReconnectAttempts - 1),
      this.wsReconnectMaxDelayMs,
    );
    console.warn(`[daemon] ws disconnected; reconnecting in ${delay}ms`);
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = undefined;
      this.connectWs();
    }, delay);
  }

  private async heartbeat(): Promise<void> {
    if (!this.running) return;
    try {
      await this.cfg.api.post("/runtime/heartbeat", {
        runtime_ids: this.cfg.runtimeIds,
      });
    } catch (err) {
      console.warn(
        "[daemon] heartbeat failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async pollAll(): Promise<void> {
    if (!this.running) return;
    await Promise.all(this.cfg.runtimeIds.map((rid) => this.pollRuntime(rid)));
  }

  /**
   * Drain one runtime's pending queue: keep claiming until /runtime/claim
   * returns 204 or the supervisor is at capacity. Sessions are run
   * concurrently; this loop just hands off and keeps claiming.
   *
   * Transient API outages (e.g. an API restart during dev) surface as
   * fetch rejections from `claim()`. We log and bail this tick — the
   * interval + WS push will retry. Without this catch, a single
   * ECONNREFUSED bubbles up as an unhandledRejection and kills the
   * daemon under Node 20+'s `--unhandled-rejections=throw` default.
   */
  private async pollRuntime(runtimeId: string): Promise<void> {
    while (this.running && this.cfg.supervisor.hasCapacity()) {
      let payload: DispatchPayload | undefined;
      try {
        payload = await this.cfg.api.claim<DispatchPayload>(runtimeId);
      } catch (err) {
        console.warn(
          `[daemon] claim failed for runtime=${runtimeId}:`,
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      if (!payload) return;
      // Visibility: every claim shows up in the daemon's stdout. The
      // spawner logs the matching cwd + exit lines so one session id
      // can be grep'd end-to-end.
      console.log(
        `[daemon/claim] sess=${payload.session_id} agent=${payload.agent_id} runtime=${runtimeId}`,
      );
      const ctrl = this.cfg.supervisor.start(payload.session_id);
      void runDispatch(
        {
          api: this.cfg.api,
          workspaceManager: this.cfg.workspaceManager,
          runtimeRegistry: this.cfg.runtimeRegistry,
        },
        payload,
        ctrl.signal,
      )
        .catch((err: unknown) =>
          console.error(
            `[daemon] dispatch ${payload.session_id} failed:`,
            err instanceof Error ? err.message : String(err),
          ),
        )
        .finally(() => this.cfg.supervisor.finish(payload.session_id));
    }
  }
}
