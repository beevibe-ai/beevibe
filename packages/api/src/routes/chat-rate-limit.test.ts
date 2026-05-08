import { describe, expect, it } from "vitest";
import { ChatRateLimiter } from "./chat-rate-limit.js";

function makeClock() {
  let now = 1_000_000;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("ChatRateLimiter — concurrency", () => {
  it("allows one in-flight turn per key by default", () => {
    const clock = makeClock();
    const lim = new ChatRateLimiter({ now: clock.now });
    const first = lim.acquire("u_alice");
    expect(first.ok).toBe(true);
  });

  it("rejects a second concurrent turn for the same key", () => {
    const clock = makeClock();
    const lim = new ChatRateLimiter({ now: clock.now });
    const a = lim.acquire("u_alice");
    const b = lim.acquire("u_alice");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.reason).toBe("concurrent");
      expect(b.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("allows another turn after the prior is released", () => {
    const clock = makeClock();
    const lim = new ChatRateLimiter({ now: clock.now });
    const a = lim.acquire("u_alice");
    expect(a.ok).toBe(true);
    if (a.ok) a.release();
    const b = lim.acquire("u_alice");
    expect(b.ok).toBe(true);
  });

  it("scopes concurrency per key — different users don't block each other", () => {
    const clock = makeClock();
    const lim = new ChatRateLimiter({ now: clock.now });
    const a = lim.acquire("u_alice");
    const b = lim.acquire("u_bob");
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it("respects a maxConcurrent of N", () => {
    const clock = makeClock();
    const lim = new ChatRateLimiter({ maxConcurrent: 3, now: clock.now });
    const a = lim.acquire("u_alice");
    const b = lim.acquire("u_alice");
    const c = lim.acquire("u_alice");
    const d = lim.acquire("u_alice");
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(d.ok).toBe(false);
  });
});

describe("ChatRateLimiter — sliding window throughput", () => {
  it("rejects a request when the window is at capacity", () => {
    const clock = makeClock();
    const lim = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 2,
      windowMs: 60_000,
      now: clock.now,
    });
    const a = lim.acquire("u_alice");
    if (a.ok) a.release();
    const b = lim.acquire("u_alice");
    if (b.ok) b.release();
    const c = lim.acquire("u_alice");
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toBe("throughput");
      expect(c.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("forgets old timestamps once they fall outside the window", () => {
    const clock = makeClock();
    const lim = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 1,
      windowMs: 1_000,
      now: clock.now,
    });
    const a = lim.acquire("u_alice");
    if (a.ok) a.release();
    const blocked = lim.acquire("u_alice");
    expect(blocked.ok).toBe(false);
    clock.advance(1_001);
    const allowed = lim.acquire("u_alice");
    expect(allowed.ok).toBe(true);
  });

  it("retryAfterMs reflects time until the oldest entry exits the window", () => {
    const clock = makeClock();
    const lim = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 1,
      windowMs: 1_000,
      now: clock.now,
    });
    const first = lim.acquire("u_alice");
    if (first.ok) first.release();
    clock.advance(400);
    const blocked = lim.acquire("u_alice");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      // 1000 - 400 = 600 remaining until first entry expires.
      expect(blocked.retryAfterMs).toBe(600);
    }
  });
});

describe("ChatRateLimiter — release safety", () => {
  it("over-release is a no-op (doesn't go negative)", () => {
    const clock = makeClock();
    const lim = new ChatRateLimiter({ now: clock.now });
    const a = lim.acquire("u_alice");
    if (a.ok) {
      a.release();
      a.release(); // double release shouldn't break the next acquire
    }
    const b = lim.acquire("u_alice");
    expect(b.ok).toBe(true);
  });

  it("reset clears in-flight + window state", () => {
    const clock = makeClock();
    const lim = new ChatRateLimiter({ maxConcurrent: 1, now: clock.now });
    lim.acquire("u_alice");
    lim.reset();
    const after = lim.acquire("u_alice");
    expect(after.ok).toBe(true);
  });
});
