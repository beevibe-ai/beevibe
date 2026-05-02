/**
 * Postgres LISTEN client that feeds `bv_event` notifications into
 * `SseManager`. Reconnects on disconnect so the live-updates flow
 * survives DB restarts without manual intervention.
 *
 * Uses a dedicated `pg.Client` (not the pool) because LISTEN holds the
 * connection — pool checkouts would starve other queries.
 */

import { Client } from "pg";
import type { SseManager, BvEvent } from "./manager.js";
import type { OwnerLookup } from "./owner-lookup.js";

export interface SseListenerConfig {
  databaseUrl: string;
  manager: SseManager;
  ownerLookup: OwnerLookup;
  /** Default 5s. */
  reconnectDelayMs?: number;
}

const DEFAULT_RECONNECT_DELAY_MS = 5_000;

export class SseListener {
  private client?: Client;
  private stopped = false;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private readonly config: SseListenerConfig) {}

  /**
   * Fire-and-forget. Returns immediately; the listener loop runs in the
   * background. Caller awaits `stop()` to clean up.
   */
  start(): void {
    if (this.stopped) {
      throw new Error("SseListener: cannot start a stopped listener");
    }
    void this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.client) {
      try {
        await this.client.end();
      } catch {
        // already disconnected
      }
      this.client = undefined;
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce();
      } catch (err) {
        console.error("[SseListener] connect failed:", (err as Error).message);
      }
      if (this.stopped) return;
      await this.delayBeforeReconnect();
    }
  }

  private async connectOnce(): Promise<void> {
    const client = new Client({ connectionString: this.config.databaseUrl });
    this.client = client;

    client.on("notification", (msg) => {
      if (msg.channel !== "bv_event" || !msg.payload) return;
      const parsed = parseEvent(msg.payload);
      if (!parsed) return;
      // Owner lookup hits the DB; do it async and fan out when resolved.
      // Errors are logged + the event is dropped (fail-closed) so we
      // never leak across users when the lookup fails.
      this.config.ownerLookup
        .ownersOf(parsed)
        .then((owners) => this.config.manager.publish(parsed, owners))
        .catch((err) =>
          console.error(
            "[SseListener] owner lookup failed for",
            parsed.event,
            parsed.id,
            (err as Error).message,
          ),
        );
    });

    // pg.Client emits 'error' for socket-level issues, then ends the connection.
    // We don't crash the process — the outer loop reconnects.
    const closed = new Promise<void>((resolve) => {
      const finish = () => resolve();
      client.once("end", finish);
      client.once("error", (err) => {
        console.error("[SseListener] client error:", err.message);
        finish();
      });
    });

    await client.connect();
    await client.query("LISTEN bv_event");
    await closed;

    if (this.client === client) this.client = undefined;
  }

  private delayBeforeReconnect(): Promise<void> {
    const delay = this.config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    return new Promise((resolve) => {
      this.reconnectTimer = setTimeout(resolve, delay);
    });
  }
}

function parseEvent(payload: string): BvEvent | undefined {
  try {
    const raw = JSON.parse(payload) as {
      event?: unknown;
      id?: unknown;
      data?: unknown;
    };
    if (typeof raw.event !== "string" || typeof raw.id !== "string") return undefined;
    const data =
      raw.data && typeof raw.data === "object" && !Array.isArray(raw.data)
        ? (raw.data as Record<string, unknown>)
        : undefined;
    return data ? { event: raw.event, id: raw.id, data } : { event: raw.event, id: raw.id };
  } catch {
    // ignore malformed payload
  }
  return undefined;
}
