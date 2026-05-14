import { beforeEach, describe, expect, it, vi } from "vitest";
import { DaemonHub, type DaemonClient, type DaemonPushPayload } from "./hub.js";

function makeClient(
  daemonId: string,
  runtimeIds: readonly string[],
): DaemonClient & { sent: DaemonPushPayload[] } {
  const sent: DaemonPushPayload[] = [];
  return {
    daemonId,
    runtimeIds,
    sent,
    send(payload) {
      sent.push(payload);
    },
  };
}

let hub: DaemonHub;

beforeEach(() => {
  hub = new DaemonHub();
});

describe("DaemonHub.notify", () => {
  it("delivers task_available to every client subscribed to the runtime", () => {
    const a = makeClient("dmn_a", ["rt_x"]);
    const b = makeClient("dmn_b", ["rt_x", "rt_y"]);
    hub.register(a);
    hub.register(b);
    hub.notify("rt_x", "sess_1");

    expect(a.sent).toEqual([
      { type: "task_available", runtime_id: "rt_x", session_id: "sess_1" },
    ]);
    expect(b.sent).toEqual([
      { type: "task_available", runtime_id: "rt_x", session_id: "sess_1" },
    ]);
  });

  it("skips runtimes with no subscribers (no throw, no-op)", () => {
    const a = makeClient("dmn_a", ["rt_x"]);
    hub.register(a);
    hub.notify("rt_offline", "sess_1");
    expect(a.sent).toEqual([]);
  });

  it("dedupes repeat notify on the same client+session_id", () => {
    const a = makeClient("dmn_a", ["rt_x"]);
    hub.register(a);
    hub.notify("rt_x", "sess_1");
    hub.notify("rt_x", "sess_1");
    hub.notify("rt_x", "sess_1");
    expect(a.sent).toHaveLength(1);
  });

  it("does NOT dedupe across different session_ids", () => {
    const a = makeClient("dmn_a", ["rt_x"]);
    hub.register(a);
    hub.notify("rt_x", "sess_1");
    hub.notify("rt_x", "sess_2");
    expect(a.sent).toHaveLength(2);
  });

  it("dedup cache is per-client (independent buckets)", () => {
    const a = makeClient("dmn_a", ["rt_x"]);
    const b = makeClient("dmn_b", ["rt_x"]);
    hub.register(a);
    hub.register(b);
    hub.notify("rt_x", "sess_1");
    hub.notify("rt_x", "sess_1"); // dedup'd at both
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it("dedup cache evicts oldest when full (FIFO, cap 128)", () => {
    const a = makeClient("dmn_a", ["rt_x"]);
    hub.register(a);
    for (let i = 0; i < 130; i++) {
      hub.notify("rt_x", `sess_${i}`);
    }
    expect(a.sent).toHaveLength(130);
    // sess_0 evicted; re-notifying delivers again.
    hub.notify("rt_x", "sess_0");
    expect(a.sent).toHaveLength(131);
    // sess_129 still in cache; re-notifying drops.
    hub.notify("rt_x", "sess_129");
    expect(a.sent).toHaveLength(131);
  });
});

describe("DaemonHub.cancel", () => {
  it("delivers cancel to every client owned by the daemon (across runtimes)", () => {
    const a = makeClient("dmn_a", ["rt_x", "rt_y"]);
    const b = makeClient("dmn_b", ["rt_z"]);
    hub.register(a);
    hub.register(b);
    hub.cancel("dmn_a", "sess_1");
    expect(a.sent).toEqual([{ type: "cancel", session_id: "sess_1" }]);
    expect(b.sent).toEqual([]);
  });

  it("no-op when daemon has no live clients", () => {
    expect(() => hub.cancel("dmn_offline", "sess_1")).not.toThrow();
  });
});

describe("DaemonHub.unregister", () => {
  it("removes the client from every runtime bucket and the daemon bucket", () => {
    const a = makeClient("dmn_a", ["rt_x", "rt_y"]);
    hub.register(a);
    expect(hub.size()).toBe(1);
    expect(hub.hasRuntime("rt_x")).toBe(true);
    expect(hub.hasRuntime("rt_y")).toBe(true);

    hub.unregister(a);
    expect(hub.size()).toBe(0);
    expect(hub.hasRuntime("rt_x")).toBe(false);
    expect(hub.hasRuntime("rt_y")).toBe(false);

    hub.notify("rt_x", "sess_1");
    expect(a.sent).toEqual([]);
  });

  it("auto-unregisters a client whose send throws", () => {
    const broken: DaemonClient & { calls: number } = {
      daemonId: "dmn_broken",
      runtimeIds: ["rt_x"],
      calls: 0,
      send() {
        this.calls++;
        throw new Error("write after end");
      },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    hub.register(broken);
    hub.notify("rt_x", "sess_1");
    expect(broken.calls).toBe(1);
    expect(hub.hasRuntime("rt_x")).toBe(false);
    // Subsequent notify is a no-op — broken client already unregistered.
    hub.notify("rt_x", "sess_2");
    expect(broken.calls).toBe(1);
    warnSpy.mockRestore();
  });
});

describe("DaemonHub.hasRuntime", () => {
  it("returns true for any runtime with at least one live client", () => {
    const a = makeClient("dmn_a", ["rt_x"]);
    const b = makeClient("dmn_b", ["rt_x"]);
    hub.register(a);
    hub.register(b);
    expect(hub.hasRuntime("rt_x")).toBe(true);
    hub.unregister(a);
    expect(hub.hasRuntime("rt_x")).toBe(true);
    hub.unregister(b);
    expect(hub.hasRuntime("rt_x")).toBe(false);
  });
});

describe("DaemonHub.isOnline", () => {
  it("is true while a WS client is subscribed (mirrors hasRuntime)", () => {
    const a = makeClient("dmn_a", ["rt_x"]);
    hub.register(a);
    expect(hub.isOnline("rt_x")).toBe(true);
    hub.unregister(a);
    // No HTTP heartbeat after unregister, but the register itself
    // bumped lastSeen — within freshness window it's still online.
    expect(hub.isOnline("rt_x")).toBe(true);
  });

  it("falls back to heartbeat freshness when no WS client is connected", () => {
    const t0 = 1_000_000;
    hub.bumpLastSeen("rt_x", t0);
    // No register — purely an HTTP-heartbeat-only daemon.
    expect(hub.hasRuntime("rt_x")).toBe(false);
    expect(hub.isOnline("rt_x", t0 + 15_000)).toBe(true);
    // 30s freshness window: at exactly 30s still online; past that, offline.
    expect(hub.isOnline("rt_x", t0 + 30_000)).toBe(true);
    expect(hub.isOnline("rt_x", t0 + 30_001)).toBe(false);
  });

  it("returns false for a runtime we've never heard from", () => {
    expect(hub.isOnline("rt_never")).toBe(false);
  });

  it("survives a WS drop when heartbeats keep arriving", () => {
    const t0 = 1_000_000;
    const a = makeClient("dmn_a", ["rt_x"]);
    hub.register(a); // bumps lastSeen at t=t0
    hub.unregister(a);
    // 25s later — past nothing yet, well within freshness even without
    // a heartbeat top-up. (Real daemons heartbeat at 15s, so they'd
    // refresh long before this.)
    expect(hub.isOnline("rt_x", t0 + 25_000)).toBe(true);
    // A heartbeat at t=29s extends the window.
    hub.bumpLastSeen("rt_x", t0 + 29_000);
    expect(hub.isOnline("rt_x", t0 + 50_000)).toBe(true);
  });
});
