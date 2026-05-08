/**
 * Per-token rate limiter for `POST /chat`.
 *
 * Each chat turn spawns a Claude Code subprocess (~30s, real $$).
 * Without per-token throttling, a misbehaving client or compromised
 * `bv_u_` token could drain budget in a tight loop. We enforce two
 * separate ceilings:
 *
 *   - `maxConcurrent`: how many turns can be in flight for the same
 *     token simultaneously. Defaults to 1, which both protects against
 *     accidental double-fire (network retries, double-click) and
 *     forms the basis of the idempotency check (the route uses the
 *     same key — the bv_u_ token — as a coarse mutex).
 *
 *   - `maxPerWindow` over `windowMs`: sliding-window cap on turns
 *     started by the same token. Defaults to 30 turns / 60s, which
 *     is generous for real human typing speed but stops scripted
 *     abuse cold.
 *
 * In-memory only — fine for single-process api in dev/early prod. If
 * we move to multi-instance, swap for a Redis-backed implementation
 * with the same `acquire`/`release` shape.
 */

export type RateLimitOutcome =
  | { ok: true; release: () => void }
  | { ok: false; reason: "concurrent" | "throughput"; retryAfterMs: number };

export interface ChatRateLimiterOptions {
  maxConcurrent?: number;
  maxPerWindow?: number;
  windowMs?: number;
  /** Test seam — defaults to `Date.now()`. */
  now?: () => number;
}

export class ChatRateLimiter {
  private readonly maxConcurrent: number;
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, number>();
  private readonly windows = new Map<string, number[]>();

  constructor(opts: ChatRateLimiterOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 1;
    this.maxPerWindow = opts.maxPerWindow ?? 30;
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Try to acquire a slot for this token. On success, returns a
   * `release()` to call when the turn finishes (success OR failure).
   * On failure, returns the reason + how long until the caller could
   * legitimately retry — handy for `Retry-After` headers.
   */
  acquire(key: string): RateLimitOutcome {
    const now = this.now();

    // Drop expired timestamps before counting (also reclaims memory
    // from one-time visitors via the windows.delete branch below).
    const window = this.windows.get(key) ?? [];
    const cutoff = now - this.windowMs;
    while (window.length > 0 && window[0]! < cutoff) window.shift();

    if (window.length >= this.maxPerWindow) {
      const oldest = window[0]!;
      return {
        ok: false,
        reason: "throughput",
        retryAfterMs: Math.max(0, oldest + this.windowMs - now),
      };
    }

    const inFlight = this.inFlight.get(key) ?? 0;
    if (inFlight >= this.maxConcurrent) {
      // Garbage-collect: window is non-empty (we just pruned), keep it.
      // But if the prune emptied the window AND nothing's in flight,
      // free the entry so long-tail visitors don't accumulate forever.
      if (window.length === 0 && inFlight === 0) this.windows.delete(key);
      else this.windows.set(key, window);
      // No clean retry-after for concurrency — depends on the LLM
      // turn duration, which we don't know. 1s hint stops hot-looping.
      return { ok: false, reason: "concurrent", retryAfterMs: 1_000 };
    }

    window.push(now);
    this.windows.set(key, window);
    this.inFlight.set(key, inFlight + 1);

    return {
      ok: true,
      release: () => {
        const remaining = (this.inFlight.get(key) ?? 1) - 1;
        if (remaining <= 0) this.inFlight.delete(key);
        else this.inFlight.set(key, remaining);
      },
    };
  }

  /** Test seam — drop all in-flight + window state. */
  reset(): void {
    this.inFlight.clear();
    this.windows.clear();
  }
}
