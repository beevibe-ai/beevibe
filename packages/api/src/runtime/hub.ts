/**
 * In-memory registry of connected daemon WebSocket clients, indexed by
 * runtime_id. The HTTP claim path is the source of truth — this hub is a
 * best-effort wakeup hint so daemons don't have to poll on a 1-second
 * cadence to feel responsive.
 *
 * Pattern lifted from Multica's hub.go, simplified for v1:
 *   - One daemon connects with N runtime_ids (one per detected CLI).
 *   - One push to runtime_id X reaches every client subscribed to X.
 *   - The dedup cache is per-client + per-(type, session_id), bounded at
 *     128 entries FIFO. Prevents the same session_id from firing two
 *     wakeups at the same client when an upstream calls notify twice.
 *   - Best-effort: send failures are swallowed. Daemons recover via the
 *     30-second HTTP claim poll if a wakeup is missed.
 *   - Single-instance API for v1 — federation across instances is a Phase
 *     10 concern (pg_notify('runtime_wakeup', json) + per-instance hubs).
 */

import { RUNTIME_HEARTBEAT_INTERVAL_MS } from "@beevibe/core";

export type DaemonPushPayload =
  | { type: "task_available"; runtime_id: string; session_id: string }
  | { type: "cancel"; session_id: string };

export interface DaemonClient {
  daemonId: string;
  runtimeIds: readonly string[];
  /** Best-effort send. Hub catches throws and unregisters on failure. */
  send(payload: DaemonPushPayload): void;
}

const DEDUP_CAP = 128;

/**
 * How recently we need to have heard from a daemon (HTTP heartbeat OR
 * WS upgrade) for its runtimes to count as "online". Derived from the
 * shared `RUNTIME_HEARTBEAT_INTERVAL_MS` so the two values can't drift —
 * 2× gives one missed-beat of slack before flipping offline.
 *
 * Why this matters: `hasRuntime` only knows about WS pushes — a daemon
 * whose WebSocket briefly dropped but is still heartbeating via HTTP
 * looks "offline" to anyone checking `hasRuntime`, even though chat
 * dispatches would land on the next 30s HTTP claim poll. `isOnline`
 * adds the heartbeat fallback so the chat 503 fast-fail and the UI's
 * online dot don't false-negative on WS blips.
 */
const ONLINE_FRESHNESS_MS = 2 * RUNTIME_HEARTBEAT_INTERVAL_MS;

export class DaemonHub {
  private readonly byRuntimeId = new Map<string, Set<DaemonClient>>();
  private readonly byDaemonId = new Map<string, Set<DaemonClient>>();
  private readonly dedup = new WeakMap<DaemonClient, Set<string>>();
  /**
   * Last time we heard from each runtime, via WS upgrade or HTTP
   * heartbeat. Read by `isOnline`. Bumped from `bumpLastSeen` (called
   * by the heartbeat HTTP handler) and from `register` (called by
   * RuntimeWsServer.onConnect). Process-local; lost on api restart,
   * which is fine — the next heartbeat (within 15s) refills it.
   */
  private readonly lastSeen = new Map<string, number>();

  register(client: DaemonClient): void {
    const now = Date.now();
    for (const rid of client.runtimeIds) {
      let bucket = this.byRuntimeId.get(rid);
      if (!bucket) {
        bucket = new Set();
        this.byRuntimeId.set(rid, bucket);
      }
      bucket.add(client);
      // WS upgrade counts as a liveness signal — route through the same
      // method as the HTTP heartbeat handler so there's one canonical
      // path for "we just heard from this runtime."
      this.bumpLastSeen(rid, now);
    }
    let dbucket = this.byDaemonId.get(client.daemonId);
    if (!dbucket) {
      dbucket = new Set();
      this.byDaemonId.set(client.daemonId, dbucket);
    }
    dbucket.add(client);
    this.dedup.set(client, new Set());
  }

  unregister(client: DaemonClient): void {
    for (const rid of client.runtimeIds) {
      const bucket = this.byRuntimeId.get(rid);
      if (!bucket) continue;
      bucket.delete(client);
      if (bucket.size === 0) this.byRuntimeId.delete(rid);
    }
    const dbucket = this.byDaemonId.get(client.daemonId);
    if (dbucket) {
      dbucket.delete(client);
      if (dbucket.size === 0) this.byDaemonId.delete(client.daemonId);
    }
    this.dedup.delete(client);
  }

  /**
   * Wake all clients subscribed to `runtimeId` so they claim the pending
   * session. Idempotent: a duplicate notify on the same session is dropped
   * by the per-client dedup cache.
   */
  notify(runtimeId: string, sessionId: string): void {
    const bucket = this.byRuntimeId.get(runtimeId);
    if (!bucket || bucket.size === 0) return;
    const payload: DaemonPushPayload = {
      type: "task_available",
      runtime_id: runtimeId,
      session_id: sessionId,
    };
    for (const client of bucket) {
      this.deliver(client, `task_available:${sessionId}`, payload);
    }
  }

  /**
   * Push a cancel frame to every client owned by the daemon. Sent when a
   * human or escalation cancels an in-flight session — the daemon SIGTERMs
   * the matching subprocess. Multiple clients per daemon would mean
   * separate WS connections; sending to all is safe because cancel is
   * idempotent.
   */
  cancel(daemonId: string, sessionId: string): void {
    const bucket = this.byDaemonId.get(daemonId);
    if (!bucket || bucket.size === 0) return;
    const payload: DaemonPushPayload = { type: "cancel", session_id: sessionId };
    for (const client of bucket) {
      this.deliver(client, `cancel:${sessionId}`, payload);
    }
  }

  /** Total live connections — exposed for /health and tests. */
  size(): number {
    let n = 0;
    for (const bucket of this.byDaemonId.values()) n += bucket.size;
    return n;
  }

  /**
   * Is this runtime currently WS-subscribed? Narrow — true only when a
   * push-channel client is connected RIGHT NOW. Use this for things
   * that need an immediate-delivery guarantee (`hub.notify` internal
   * fan-out). For "is the daemon reachable at all," prefer `isOnline`.
   */
  hasRuntime(runtimeId: string): boolean {
    return (this.byRuntimeId.get(runtimeId)?.size ?? 0) > 0;
  }

  /**
   * Is this runtime reachable via any channel — WS push OR recent HTTP
   * heartbeat? Broader than `hasRuntime`; this is what user-facing
   * surfaces (chat 503 fast-fail, online dot) should use so a WS blip
   * doesn't false-negative against a daemon that's still heartbeating.
   */
  isOnline(runtimeId: string, now: number = Date.now()): boolean {
    if (this.hasRuntime(runtimeId)) return true;
    const seen = this.lastSeen.get(runtimeId);
    return seen !== undefined && now - seen <= ONLINE_FRESHNESS_MS;
  }

  /**
   * Note a liveness signal for a runtime. Called by the HTTP heartbeat
   * route so `isOnline` includes daemons whose WS dropped but are still
   * heartbeating. WS register also bumps this implicitly.
   */
  bumpLastSeen(runtimeId: string, now: number = Date.now()): void {
    this.lastSeen.set(runtimeId, now);
  }

  private deliver(
    client: DaemonClient,
    dedupKey: string,
    payload: DaemonPushPayload,
  ): void {
    const seen = this.dedup.get(client);
    if (!seen) return;
    if (seen.has(dedupKey)) return;
    if (seen.size >= DEDUP_CAP) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.add(dedupKey);
    try {
      client.send(payload);
    } catch (err) {
      console.warn("[hub] send failed; unregistering client", {
        daemonId: client.daemonId,
        err: err instanceof Error ? err.message : String(err),
      });
      this.unregister(client);
    }
  }
}
