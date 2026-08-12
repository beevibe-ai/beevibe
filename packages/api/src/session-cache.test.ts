import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCache } from "./session-cache.js";

describe("SessionCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("set + get round-trips an mcpSid → beevibeSid mapping", () => {
    const cache = new SessionCache();

    cache.set("mcp-1", "beevibe-1");
    expect(cache.get("mcp-1")).toBe("beevibe-1");
    expect(cache.size()).toBe(1);
  });

  it("get on unknown sid returns undefined", () => {
    const cache = new SessionCache();
    expect(cache.get("unknown")).toBeUndefined();
  });

  it("LRU evicts oldest when maxEntries reached on set() and fires onEvict (no status write)", async () => {
    const onEvict = vi.fn(async () => {});
    const cache = new SessionCache({ maxEntries: 2, onEvict });

    cache.set("A", "beevibe-A");
    await vi.advanceTimersByTimeAsync(10);
    cache.set("B", "beevibe-B");
    await vi.advanceTimersByTimeAsync(10);
    cache.set("C", "beevibe-C"); // forces eviction of A (oldest lastAccess)

    expect(cache.size()).toBe(2);
    expect(cache.get("A")).toBeUndefined();
    expect(cache.get("B")).toBe("beevibe-B");
    expect(cache.get("C")).toBe("beevibe-C");

    // Eviction is fire-and-forget (void promise) so drain the microtask queue.
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    // F-SL-1: LRU eviction must NOT write status — that happens only via
    // /runtime/done. onEvict still fires so the memory pipeline can
    // promote facts.
    expect(onEvict).toHaveBeenCalledWith("beevibe-A", "lru");
  });

  it("get() refreshes the access time so the recently-used isn't evicted", async () => {
    const cache = new SessionCache({ maxEntries: 2 });

    cache.set("A", "beevibe-A");
    await vi.advanceTimersByTimeAsync(10);
    cache.set("B", "beevibe-B");
    await vi.advanceTimersByTimeAsync(10);

    // Touch A — it's now newer than B
    cache.get("A");
    await vi.advanceTimersByTimeAsync(10);

    // Insert C, evicts B (oldest)
    cache.set("C", "beevibe-C");

    expect(cache.get("A")).toBe("beevibe-A");
    expect(cache.get("B")).toBeUndefined();
    expect(cache.get("C")).toBe("beevibe-C");
  });

  it("idle sweep evicts entries past idleTimeoutMs and fires onEvict (no status write)", async () => {
    const onEvict = vi.fn(async () => {});
    const cache = new SessionCache({ idleTimeoutMs: 1000, onEvict });

    cache.set("idle-sid", "beevibe-idle");
    expect(cache.size()).toBe(1);

    // Advance past idle timeout; sweep manually.
    await vi.advanceTimersByTimeAsync(1500);
    await cache.sweepIdle();

    expect(cache.size()).toBe(0);
    // F-SL-1: idle eviction is UI/promotion-only — only onEvict fires.
    expect(onEvict).toHaveBeenCalledWith("beevibe-idle", "idle");
  });

  it("idle sweep skips entries that were recently accessed", async () => {
    const onEvict = vi.fn(async () => {});
    const cache = new SessionCache({ idleTimeoutMs: 1000, onEvict });

    cache.set("fresh-sid", "beevibe-fresh");
    await vi.advanceTimersByTimeAsync(800);
    cache.get("fresh-sid"); // refresh access
    await vi.advanceTimersByTimeAsync(500);

    // Total elapsed: 1300ms; but last access was 500ms ago → not idle.
    await cache.sweepIdle();

    expect(cache.size()).toBe(1);
    expect(onEvict).not.toHaveBeenCalled();
  });

  it("explicit delete fires onEvict with reason='explicit' (no status write)", async () => {
    const onEvict = vi.fn(async () => {});
    const cache = new SessionCache({ onEvict });

    cache.set("X", "beevibe-X");
    const removed = await cache.delete("X");

    expect(removed).toBe(true);
    expect(cache.size()).toBe(0);
    expect(onEvict).toHaveBeenCalledWith("beevibe-X", "explicit");
  });

  it("explicit delete on unknown sid returns false and triggers nothing", async () => {
    const onEvict = vi.fn(async () => {});
    const cache = new SessionCache({ onEvict });

    const removed = await cache.delete("never-set");

    expect(removed).toBe(false);
    expect(onEvict).not.toHaveBeenCalled();
  });

  it("eviction without an onEvict callback wired is a clean no-op", async () => {
    // Construct with no onEvict so we can verify nothing throws when the
    // hook isn't wired (e.g., tests / minimal setups). All three eviction
    // paths must remain safe.
    const cache = new SessionCache({ maxEntries: 1, idleTimeoutMs: 100 });

    cache.set("A", "beevibe-A");
    cache.set("B", "beevibe-B"); // LRU evict A
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(cache.get("A")).toBeUndefined();

    cache.set("C", "beevibe-C");
    await vi.advanceTimersByTimeAsync(500);
    await cache.sweepIdle(); // idle evict B and C
    expect(cache.size()).toBe(0);

    cache.set("D", "beevibe-D");
    await expect(cache.delete("D")).resolves.toBe(true);
  });

  it("logs and swallows an onEvict error so eviction always removes the entry", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onEvict = vi.fn(async () => {
      throw new Error("promotion blew up");
    });
    const cache = new SessionCache({ onEvict });

    cache.set("X", "beevibe-X");
    const removed = await cache.delete("X");

    expect(removed).toBe(true);
    expect(cache.size()).toBe(0);
    expect(onEvict).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("startIdleSweep is idempotent and stopIdleSweep clears the timer", () => {
    const cache = new SessionCache();

    cache.startIdleSweep(1000);
    cache.startIdleSweep(1000); // no-op
    cache.stopIdleSweep();
    cache.stopIdleSweep(); // no-op

    expect(cache.size()).toBe(0);
  });
});
