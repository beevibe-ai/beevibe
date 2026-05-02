/**
 * In-memory subscriber registry for SSE fanout. Process-singleton —
 * `SseListener` (the pg LISTEN client) feeds events in via `publish`;
 * `routes/stream.ts` per-browser handlers register callbacks via
 * `subscribe`. No persistence: an event missed during a disconnect is
 * lost, but React Query refetches on focus/reconnect so it converges.
 */

export interface BvEvent {
  /** Dotted name like `task.updated`. See `web/lib/sse.ts:eventInvalidations`. */
  event: string;
  /** Row id of whatever changed. */
  id: string;
  /**
   * Optional structured payload. Cache-invalidation events (task.updated
   * etc.) leave this undefined — the browser refetches via the existing
   * GET endpoints. Push events (session.step, …) carry the data inline
   * so subscribers can render without a round-trip.
   */
  data?: Record<string, unknown>;
}

export type SseSubscriber = (event: BvEvent) => void;

export class SseManager {
  private readonly subscribers = new Set<SseSubscriber>();

  subscribe(cb: SseSubscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  publish(event: BvEvent): void {
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch (err) {
        console.error("[SseManager] subscriber threw:", (err as Error).message);
      }
    }
  }

  /** Test/diagnostic helper. */
  size(): number {
    return this.subscribers.size;
  }
}
