import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRepository } from "@beevibe/core";
import { SessionCache } from "./session-cache.js";

function fakeSessionRepo(): { repo: SessionRepository; updates: Array<{ id: string; patch: unknown }> } {
  const updates: Array<{ id: string; patch: unknown }> = [];
  const repo = {
    update: vi.fn(async (id: string, patch: unknown) => {
      updates.push({ id, patch });
      return {} as unknown as ReturnType<SessionRepository["update"]>;
    }),
  } as unknown as SessionRepository;
  return { repo, updates };
}

describe("SessionCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("set + get round-trips an mcpSid → beevibeSid mapping", () => {
    const { repo } = fakeSessionRepo();
    const cache = new SessionCache({ sessionRepo: repo });

    cache.set("mcp-1", "beevibe-1");
    expect(cache.get("mcp-1")).toBe("beevibe-1");
    expect(cache.size()).toBe(1);
  });

  it("get on unknown sid returns undefined", () => {
    const { repo } = fakeSessionRepo();
    const cache = new SessionCache({ sessionRepo: repo });
    expect(cache.get("unknown")).toBeUndefined();
  });

  it("LRU evicts oldest when maxEntries reached on set()", async () => {
    const { repo, updates } = fakeSessionRepo();
    const onEvict = vi.fn(async () => {});
    const cache = new SessionCache({ sessionRepo: repo, maxEntries: 2, onEvict });

    cache.set("A", "beevibe-A");
    await vi.advanceTimersByTimeAsync(10);
    cache.set("B", "beevibe-B");
    await vi.advanceTimersByTimeAsync(10);
    cache.set("C", "beevibe-C"); // forces eviction of A (oldest lastAccess)

    expect(cache.size()).toBe(2);
    expect(cache.get("A")).toBeUndefined();
    expect(cache.get("B")).toBe("beevibe-B");
    expect(cache.get("C")).toBe("beevibe-C");

    // The evicted A should have been promoted via repo.update + onEvict.
    // Eviction is fire-and-forget (void promise) so we drain the microtask queue.
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    expect(updates.length).toBe(1);
    expect(updates[0]?.id).toBe("beevibe-A");
    expect(onEvict).toHaveBeenCalledWith("beevibe-A", "lru");
  });

  it("get() refreshes the access time so the recently-used isn't evicted", async () => {
    const { repo } = fakeSessionRepo();
    const cache = new SessionCache({ sessionRepo: repo, maxEntries: 2 });

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

  it("idle sweep evicts entries past idleTimeoutMs and triggers update + onEvict", async () => {
    const { repo, updates } = fakeSessionRepo();
    const onEvict = vi.fn(async () => {});
    const cache = new SessionCache({
      sessionRepo: repo,
      idleTimeoutMs: 1000,
      onEvict,
    });

    cache.set("idle-sid", "beevibe-idle");
    expect(cache.size()).toBe(1);

    // Advance past idle timeout; sweep manually.
    await vi.advanceTimersByTimeAsync(1500);
    await cache.sweepIdle();

    expect(cache.size()).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.id).toBe("beevibe-idle");
    expect((updates[0]?.patch as { status: string }).status).toBe("succeeded");
    expect(onEvict).toHaveBeenCalledWith("beevibe-idle", "idle");
  });

  it("idle sweep skips entries that were recently accessed", async () => {
    const { repo, updates } = fakeSessionRepo();
    const cache = new SessionCache({ sessionRepo: repo, idleTimeoutMs: 1000 });

    cache.set("fresh-sid", "beevibe-fresh");
    await vi.advanceTimersByTimeAsync(800);
    cache.get("fresh-sid"); // refresh access
    await vi.advanceTimersByTimeAsync(500);

    // Total elapsed: 1300ms; but last access was 500ms ago → not idle.
    await cache.sweepIdle();

    expect(cache.size()).toBe(1);
    expect(updates).toHaveLength(0);
  });

  it("explicit delete fires onEvict with reason='explicit' and updates the session row", async () => {
    const { repo, updates } = fakeSessionRepo();
    const onEvict = vi.fn(async () => {});
    const cache = new SessionCache({ sessionRepo: repo, onEvict });

    cache.set("X", "beevibe-X");
    const removed = await cache.delete("X");

    expect(removed).toBe(true);
    expect(cache.size()).toBe(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.id).toBe("beevibe-X");
    expect(onEvict).toHaveBeenCalledWith("beevibe-X", "explicit");
  });

  it("explicit delete on unknown sid returns false and triggers nothing", async () => {
    const { repo, updates } = fakeSessionRepo();
    const onEvict = vi.fn(async () => {});
    const cache = new SessionCache({ sessionRepo: repo, onEvict });

    const removed = await cache.delete("never-set");

    expect(removed).toBe(false);
    expect(updates).toHaveLength(0);
    expect(onEvict).not.toHaveBeenCalled();
  });

  it("startIdleSweep is idempotent and stopIdleSweep clears the timer", () => {
    const { repo } = fakeSessionRepo();
    const cache = new SessionCache({ sessionRepo: repo });

    cache.startIdleSweep(1000);
    cache.startIdleSweep(1000); // no-op
    cache.stopIdleSweep();
    cache.stopIdleSweep(); // no-op

    expect(cache.size()).toBe(0);
  });
});
