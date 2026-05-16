/**
 * In-memory subscriber registry for SSE fanout. Process-singleton —
 * `SseListener` (the pg LISTEN client) feeds events in via `publish`;
 * `routes/stream.ts` per-browser handlers register callbacks via
 * `subscribe`. No persistence: an event missed during a disconnect is
 * lost, but React Query refetches on focus/reconnect so it converges.
 *
 * Per-user filtering: each subscriber registers with the caller's
 * `personId`. The listener resolves an event's owner set (via
 * `OwnerLookup`) and passes it to `publish`; subscribers only fire when
 * their personId is in the owner set. Events with an empty owner set
 * (entity gone, unknown event type, or DB lookup failed) are dropped —
 * fail-closed so we never leak across users when ownership lookup
 * fails.
 */

export interface BvEvent {
  /** Dotted name like `task.updated`. See `web/lib/sse.ts:eventInvalidations`. */
  event: string;
  /** Row id of whatever changed. */
  id: string;
  /**
   * Inline payload for push-style events (e.g. `session.step` carries
   * kind/tool_name/content so the chat UI can render without a
   * round-trip). Cache-invalidation events (e.g. `task.updated`) omit
   * this and the client refetches by id.
   */
  data?: Record<string, unknown>;
}

export type SseSubscriber = (event: BvEvent) => void;

interface RegisteredSubscriber {
  personId: string;
  cb: SseSubscriber;
}

export class SseManager {
  private readonly subscribers = new Set<RegisteredSubscriber>();

  /**
   * Register a subscriber for events owned by `personId`. Events
   * published with an owner set that does NOT contain `personId` are
   * skipped for this subscriber.
   */
  subscribe(personId: string, cb: SseSubscriber): () => void {
    const entry: RegisteredSubscriber = { personId, cb };
    this.subscribers.add(entry);
    return () => {
      this.subscribers.delete(entry);
    };
  }

  /**
   * Fan out an event to subscribers whose personId is in `owners`.
   * `owners` is a frozen set produced by the listener via OwnerLookup;
   * empty set drops the event (fail-closed).
   */
  publish(event: BvEvent, owners: ReadonlySet<string>): void {
    if (owners.size === 0) return;
    for (const sub of this.subscribers) {
      if (!owners.has(sub.personId)) continue;
      try {
        sub.cb(event);
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
