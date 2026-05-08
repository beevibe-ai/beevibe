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
