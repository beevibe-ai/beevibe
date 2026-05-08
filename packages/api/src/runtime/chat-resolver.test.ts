import { describe, expect, it, vi } from "vitest";
import type { Session } from "@beevibe/core";
import { ChatResolver } from "./chat-resolver.js";

function fakeSession(id: string, status: Session["status"] = "succeeded"): Session {
  return {
    id,
    agent_id: "agent_test",
    type: "chat",
    status,
    intent: "hello",
    result_summary: "world",
    created_at: new Date(),
  };
}

describe("ChatResolver", () => {
  it("resolves the awaiting promise with the session row when fire matches", async () => {
    const r = new ChatResolver();
    const promise = r.register("sess_1", 1000);
    expect(r.has("sess_1")).toBe(true);

    const fired = r.resolve("sess_1", fakeSession("sess_1"));
    expect(fired).toBe(true);
    expect(r.has("sess_1")).toBe(false);
    const result = await promise;
    expect(result.id).toBe("sess_1");
    expect(result.result_summary).toBe("world");
  });

  it("returns false from resolve() when no resolver is registered", () => {
    const r = new ChatResolver();
    expect(r.resolve("sess_ghost", fakeSession("sess_ghost"))).toBe(false);
  });

  it("rejects the awaiting promise after timeoutMs with no resolution", async () => {
    vi.useFakeTimers();
    try {
      const r = new ChatResolver();
      const promise = r.register("sess_1", 100);
      const captured: unknown[] = [];
      promise.catch((err) => captured.push(err));
      await vi.advanceTimersByTimeAsync(100);
      expect(r.has("sess_1")).toBe(false);
      // Flush microtasks for the rejection handler.
      await vi.advanceTimersByTimeAsync(0);
      expect((captured[0] as Error).message).toMatch(/timeout/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-registering on the same sessionId rejects the prior promise", async () => {
    const r = new ChatResolver();
    const first = r.register("sess_1", 1000);
    const captured: unknown[] = [];
    first.catch((err) => captured.push(err));

    const second = r.register("sess_1", 1000);
    await Promise.resolve();
    expect((captured[0] as Error).message).toMatch(/already registered/);

    r.resolve("sess_1", fakeSession("sess_1"));
    expect((await second).id).toBe("sess_1");
  });

  it("size() reflects live registrations", () => {
    const r = new ChatResolver();
    expect(r.size()).toBe(0);
    void r.register("a", 1000);
    void r.register("b", 1000);
    expect(r.size()).toBe(2);
    r.resolve("a", fakeSession("a"));
    expect(r.size()).toBe(1);
  });
});
