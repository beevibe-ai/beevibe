import { describe, expect, it, vi } from "vitest";
import type { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import type WebSocket from "ws";
import type { ApiClient } from "./api-client.js";
import { Claimer } from "./claimer.js";
import { Supervisor } from "./supervisor.js";

interface FakeWs {
  on(event: string, cb: (...args: unknown[]) => void): FakeWs;
  removeAllListeners(): void;
  close(): void;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  /** Fire a synthetic event so tests can simulate `open`, `pong`, `close`. */
  fire(event: string, ...args: unknown[]): void;
}

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  // Minimal stub — Claimer only uses claim/post/openWebSocket.
  return {
    claim: vi.fn(async () => undefined),
    post: vi.fn(async () => ({ status: 204, body: undefined })),
    openWebSocket: vi.fn(() => fakeWs()),
    ...overrides,
  } as unknown as ApiClient;
}

function fakeWs(): WebSocket & FakeWs {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const ws: FakeWs = {
    on(event, cb) {
      const arr = handlers.get(event) ?? [];
      arr.push(cb);
      handlers.set(event, arr);
      return ws;
    },
    removeAllListeners() {
      handlers.clear();
    },
    close() {},
    ping: vi.fn(),
    terminate: vi.fn(() => {
      // Real ws.terminate destroys the socket and fires `close` next tick;
      // mirror that synchronously so tests don't need an extra timer step.
      for (const cb of handlers.get("close") ?? []) cb();
    }),
    fire(event, ...args) {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
  };
  return ws as unknown as WebSocket & FakeWs;
}

/**
 * Wire a Claimer to a fake-ws factory that records every socket the
 * production code constructs; tests then drive `open`/`pong` and inspect
 * `ping`/`terminate`. Aggressive intervals + backoff cap let
 * `vi.advanceTimersByTime` cover a full reconnect cycle in tens of ms.
 */
function startClaimerWithFakeWs(): {
  claimer: Claimer;
  sockets: Array<WebSocket & FakeWs>;
} {
  const sockets: Array<WebSocket & FakeWs> = [];
  const api = makeApi({
    openWebSocket: vi.fn(() => {
      const ws = fakeWs();
      sockets.push(ws);
      return ws;
    }) as unknown as ApiClient["openWebSocket"],
  });
  const claimer = new Claimer({
    api,
    supervisor: new Supervisor(2),
    workspaceManager: {} as LocalWorkspaceManager,
    runtimeRegistry: {},
    runtimeIds: ["rt_1"],
    pollIntervalMs: 600_000,
    heartbeatIntervalMs: 600_000,
    wsPingIntervalMs: 1_000,
    wsReconnectMaxDelayMs: 10,
  });
  claimer.start();
  return { claimer, sockets };
}

describe("Claimer ws ping watchdog", () => {
  it("pings on each tick and terminates+reconnects when no pong arrives", async () => {
    vi.useFakeTimers();
    const { claimer, sockets } = startClaimerWithFakeWs();
    try {
      // First WS is created synchronously inside start().
      expect(sockets).toHaveLength(1);
      sockets[0]!.fire("open");

      // Tick 1: alive started true → ping sent, alive flipped to false.
      vi.advanceTimersByTime(1_000);
      expect(sockets[0]!.ping).toHaveBeenCalledTimes(1);
      expect(sockets[0]!.terminate).not.toHaveBeenCalled();

      // Tick 2: still no pong → terminate → synthetic close → reconnect.
      vi.advanceTimersByTime(1_000);
      expect(sockets[0]!.terminate).toHaveBeenCalledTimes(1);

      // Backoff (capped at 10ms) → second openWebSocket call.
      vi.advanceTimersByTime(20);
      expect(sockets).toHaveLength(2);
    } finally {
      await claimer.stop();
      vi.useRealTimers();
    }
  });

  it("does not terminate when pong arrives between pings", async () => {
    vi.useFakeTimers();
    const { claimer, sockets } = startClaimerWithFakeWs();
    try {
      sockets[0]!.fire("open");

      vi.advanceTimersByTime(1_000);
      expect(sockets[0]!.ping).toHaveBeenCalledTimes(1);
      sockets[0]!.fire("pong");

      vi.advanceTimersByTime(1_000);
      expect(sockets[0]!.ping).toHaveBeenCalledTimes(2);
      expect(sockets[0]!.terminate).not.toHaveBeenCalled();

      sockets[0]!.fire("pong");
      vi.advanceTimersByTime(1_000);
      expect(sockets[0]!.ping).toHaveBeenCalledTimes(3);
      expect(sockets[0]!.terminate).not.toHaveBeenCalled();
      expect(sockets).toHaveLength(1);
    } finally {
      await claimer.stop();
      vi.useRealTimers();
    }
  });
});

describe("Claimer.pollRuntime resilience", () => {
  it("swallows ECONNREFUSED from claim() without bubbling — daemon survives", async () => {
    const claim = vi.fn(async () => {
      // Mirror the actual shape of a Node 20+ fetch failure.
      throw new TypeError("fetch failed");
    });
    const api = makeApi({ claim } as Partial<ApiClient>);
    const claimer = new Claimer({
      api,
      supervisor: new Supervisor(2),
      workspaceManager: {} as LocalWorkspaceManager,
      runtimeRegistry: {},
      runtimeIds: ["rt_1"],
      pollIntervalMs: 60_000,
      heartbeatIntervalMs: 60_000,
    });

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      claimer.start();
      // Yield twice — once for the initial pollAll, once for any deferred reject.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(claim).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await claimer.stop();
    }
  });
});
