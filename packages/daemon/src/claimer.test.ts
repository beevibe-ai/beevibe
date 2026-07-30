import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import type WebSocket from "ws";
import type { ApiClient } from "./api-client.js";
import { Claimer } from "./claimer.js";
import { Supervisor } from "./supervisor.js";
import type { DispatchPayload } from "./spawner.js";

const { runDispatchMock } = vi.hoisted(() => ({ runDispatchMock: vi.fn() }));

vi.mock("./spawner.js", () => ({ runDispatch: runDispatchMock }));
vi.mock("./logger.js", () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

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

function dispatch(overrides: Partial<DispatchPayload> = {}): DispatchPayload {
  return {
    session_id: "sess_1",
    agent_id: "agent_1",
    agent_api_key: "bv_a_test",
    agent_hierarchy_level: "ic",
    runtime_type: "claude",
    intent: "work",
    system_prompt_append: "",
    env: {},
    type: "task",
    mcp_server_url: "http://api.test/mcp",
    ...overrides,
  };
}

/** A Claimer with quiet timers: only explicit triggers drive it. */
function makeClaimer(
  api: ApiClient,
  supervisor = new Supervisor(2),
  runtimeIds = ["rt_1", "rt_2"],
): { claimer: Claimer; supervisor: Supervisor } {
  return {
    claimer: new Claimer({
      api,
      supervisor,
      workspaceManager: {} as LocalWorkspaceManager,
      runtimeRegistry: {},
      runtimeIds,
      pollIntervalMs: 600_000,
      heartbeatIntervalMs: 600_000,
      wsPingIntervalMs: 600_000,
    }),
    supervisor,
  };
}

/** Let queued microtasks and the poll loop settle. */
const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  runDispatchMock.mockReset();
  runDispatchMock.mockResolvedValue(undefined);
});

describe("Claimer heartbeat", () => {
  it("posts every registered runtime id on start", async () => {
    const post = vi.fn(async () => ({ status: 204, body: undefined }));
    const { claimer } = makeClaimer(makeApi({ post } as Partial<ApiClient>));

    claimer.start();
    await settle();
    await claimer.stop();

    expect(post).toHaveBeenCalledWith("/runtime/heartbeat", {
      runtime_ids: ["rt_1", "rt_2"],
    });
  });

  it("survives a heartbeat POST failure", async () => {
    const post = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const { claimer } = makeClaimer(makeApi({ post } as Partial<ApiClient>));

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      claimer.start();
      await settle();
      expect(post).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await claimer.stop();
    }
  });

  it("stops heartbeating once stopped", async () => {
    const post = vi.fn(async () => ({ status: 204, body: undefined }));
    const { claimer } = makeClaimer(makeApi({ post } as Partial<ApiClient>));

    claimer.start();
    await settle();
    await claimer.stop();
    const afterStop = post.mock.calls.length;
    await settle();

    expect(post).toHaveBeenCalledTimes(afterStop);
  });
});

describe("Claimer claim handoff", () => {
  it("drains a runtime's queue until /runtime/claim returns nothing", async () => {
    const claim = vi
      .fn()
      .mockResolvedValueOnce(dispatch({ session_id: "sess_1" }))
      .mockResolvedValueOnce(dispatch({ session_id: "sess_2" }))
      .mockResolvedValue(undefined);
    const { claimer } = makeClaimer(
      makeApi({ claim } as Partial<ApiClient>),
      new Supervisor(2),
      ["rt_1"],
    );

    claimer.start();
    await settle();
    await claimer.stop();

    expect(runDispatchMock.mock.calls.map((c: unknown[]) => (c[1] as DispatchPayload).session_id))
      .toEqual(["sess_1", "sess_2"]);
  });

  it("aborts an in-flight dispatch when the claimer stops", async () => {
    // Never resolves: the session stays in-flight so stop() has something
    // to cancel.
    runDispatchMock.mockImplementation(() => new Promise(() => {}));
    const claim = vi.fn().mockResolvedValueOnce(dispatch()).mockResolvedValue(undefined);
    const { claimer } = makeClaimer(
      makeApi({ claim } as Partial<ApiClient>),
      new Supervisor(2),
      ["rt_1"],
    );

    claimer.start();
    await settle();

    const signal = runDispatchMock.mock.calls[0]?.[2] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await claimer.stop();
    expect(signal.aborted).toBe(true);
  });

  it("releases the supervisor slot when a dispatch throws", async () => {
    const claim = vi.fn().mockResolvedValueOnce(dispatch()).mockResolvedValue(undefined);
    const supervisor = new Supervisor(2);
    runDispatchMock.mockRejectedValue(new Error("spawn failed"));
    const { claimer } = makeClaimer(
      makeApi({ claim } as Partial<ApiClient>),
      supervisor,
      ["rt_1"],
    );

    claimer.start();
    await settle();
    await settle();

    expect(supervisor.hasCapacity()).toBe(true);
    await claimer.stop();
  });

  it("stops claiming once the supervisor is at capacity", async () => {
    // Never resolves: the slot stays held for the whole test.
    runDispatchMock.mockImplementation(() => new Promise(() => {}));
    const claim = vi.fn(async () => dispatch({ session_id: `sess_${claim.mock.calls.length}` }));
    const { claimer } = makeClaimer(
      makeApi({ claim } as Partial<ApiClient>),
      new Supervisor(1),
      ["rt_1"],
    );

    claimer.start();
    await settle();
    await claimer.stop();

    expect(runDispatchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Claimer ws push handling", () => {
  function connected(api: ApiClient): {
    claimer: Claimer;
    socket: WebSocket & FakeWs;
  } {
    let socket: (WebSocket & FakeWs) | undefined;
    const withWs = makeApi({
      ...api,
      openWebSocket: vi.fn(() => {
        socket = fakeWs();
        return socket;
      }) as unknown as ApiClient["openWebSocket"],
    } as Partial<ApiClient>);
    const { claimer } = makeClaimer(withWs);
    claimer.start();
    return { claimer, socket: socket! };
  }

  it("claims the named runtime on a task_available push", async () => {
    const claim = vi.fn(async () => undefined);
    const { claimer, socket } = connected(makeApi({ claim } as Partial<ApiClient>));
    await settle();
    claim.mockClear();

    socket.fire("message", Buffer.from(JSON.stringify({
      type: "task_available",
      runtime_id: "rt_2",
    })));
    await settle();

    expect(claim).toHaveBeenCalledWith("rt_2");
    await claimer.stop();
  });

  it("cancels the named session on a cancel push", async () => {
    const supervisor = new Supervisor(2);
    const cancel = vi.spyOn(supervisor, "cancel");
    let socket: (WebSocket & FakeWs) | undefined;
    const api = makeApi({
      openWebSocket: vi.fn(() => {
        socket = fakeWs();
        return socket;
      }) as unknown as ApiClient["openWebSocket"],
    });
    const { claimer } = makeClaimer(api, supervisor);
    claimer.start();

    socket!.fire("message", Buffer.from(JSON.stringify({
      type: "cancel",
      session_id: "sess_9",
    })));

    expect(cancel).toHaveBeenCalledWith("sess_9");
    await claimer.stop();
  });

  it.each([
    { raw: "not json", label: "unparseable frames" },
    { raw: '{"type":"task_available"}', label: "a task_available with no runtime_id" },
    { raw: '{"type":"cancel"}', label: "a cancel with no session_id" },
    { raw: '{"type":"something_else","runtime_id":"rt_1"}', label: "unknown push types" },
  ])("ignores $label", async ({ raw }) => {
    const claim = vi.fn(async () => undefined);
    const { claimer, socket } = connected(makeApi({ claim } as Partial<ApiClient>));
    await settle();
    claim.mockClear();

    expect(() => socket.fire("message", Buffer.from(raw))).not.toThrow();
    await settle();

    expect(claim).not.toHaveBeenCalled();
    await claimer.stop();
  });

  it("logs a ws error without reconnecting — close drives that", async () => {
    const { claimer, socket } = connected(makeApi());

    expect(() => socket.fire("error", new Error("ECONNRESET"))).not.toThrow();

    await claimer.stop();
  });

  it("does not reconnect after stop()", async () => {
    const sockets: Array<WebSocket & FakeWs> = [];
    const api = makeApi({
      openWebSocket: vi.fn(() => {
        const ws = fakeWs();
        sockets.push(ws);
        return ws;
      }) as unknown as ApiClient["openWebSocket"],
    });
    const { claimer } = makeClaimer(api);

    claimer.start();
    await claimer.stop();
    sockets[0]!.fire("close");
    await settle();

    expect(sockets).toHaveLength(1);
  });

  it("is idempotent — a second start() does not open a second socket", async () => {
    const sockets: Array<WebSocket & FakeWs> = [];
    const api = makeApi({
      openWebSocket: vi.fn(() => {
        const ws = fakeWs();
        sockets.push(ws);
        return ws;
      }) as unknown as ApiClient["openWebSocket"],
    });
    const { claimer } = makeClaimer(api);

    claimer.start();
    claimer.start();
    await settle();

    expect(sockets).toHaveLength(1);
    await claimer.stop();
  });
});
