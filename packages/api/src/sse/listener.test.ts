/**
 * Tests for the `bv_event` LISTEN client behind live updates.
 *
 * `pg.Client` is mocked so the whole reconnect loop can be driven
 * deterministically: connect → LISTEN → notifications → disconnect →
 * reconnect. The behaviours worth locking down are the ones a live DB
 * would only exercise by accident —
 *   - the loop survives a dropped connection and a failed connect,
 *   - a malformed NOTIFY payload is dropped instead of crashing the
 *     listener (the payload comes from a trigger, so a schema change
 *     can and will produce one),
 *   - `onEvent` fires synchronously, ahead of the async owner lookup,
 *     because MeshServer uses it to fast-fail callers, and a throwing
 *     subscriber must not take the SSE fan-out down with it,
 *   - `stop()` actually stops: no reconnect after it, and a stopped
 *     listener refuses to restart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

/** Every Client the listener constructs, in order. */
const clients: FakeClient[] = [];

class FakeClient extends EventEmitter {
  readonly connectionString: string;
  readonly queries: string[] = [];
  connectCalls = 0;
  ended = false;
  /** When set, `connect()` rejects with it instead of resolving. */
  connectError?: Error;
  /** When set, `end()` rejects with it. */
  endError?: Error;

  constructor(config: { connectionString: string }) {
    super();
    this.connectionString = config.connectionString;
    clients.push(this);
  }

  async connect(): Promise<void> {
    this.connectCalls++;
    if (this.connectError) throw this.connectError;
  }

  async query(sql: string): Promise<{ rows: [] }> {
    this.queries.push(sql);
    return { rows: [] };
  }

  async end(): Promise<void> {
    if (this.endError) throw this.endError;
    this.ended = true;
    this.emit("end");
  }

  /** Simulate a NOTIFY arriving from Postgres. */
  notify(channel: string, payload?: string): void {
    this.emit("notification", { channel, payload });
  }
}

vi.mock("pg", () => ({
  Client: class {
    constructor(config: { connectionString: string }) {
      return new FakeClient(config) as unknown as never;
    }
  },
}));

const { SseListener } = await import("./listener.js");
type SseListenerType = InstanceType<typeof SseListener>;

interface Harness {
  listener: SseListenerType;
  published: Array<{ event: unknown; owners: ReadonlySet<string> }>;
  seen: unknown[];
  ownersOf: ReturnType<typeof vi.fn>;
}

function makeListener(
  opts: { onEvent?: (e: unknown) => void; owners?: string[] } = {},
): Harness {
  const published: Array<{ event: unknown; owners: ReadonlySet<string> }> = [];
  const seen: unknown[] = [];
  const ownersOf = vi.fn(async () => new Set(opts.owners ?? ["per_1"]));
  const listener = new SseListener({
    databaseUrl: "postgresql://test/db",
    manager: {
      publish: (event: unknown, owners: ReadonlySet<string>) =>
        published.push({ event, owners }),
    } as never,
    ownerLookup: { ownersOf } as never,
    onEvent:
      opts.onEvent ??
      ((e: unknown) => {
        seen.push(e);
      }),
    reconnectDelayMs: 1,
  });
  return { listener, published, seen, ownersOf };
}

/** Yield to the microtask queue (and, with a delay, to timers). */
const tick = (ms = 0): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `check()` holds, or fail the test on timeout. */
async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick(5);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clients.length = 0;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("SseListener lifecycle", () => {
  it("connects with the configured url and issues LISTEN bv_event", async () => {
    const { listener } = makeListener();
    listener.start();
    await until(() => clients[0]?.queries.length === 1, "LISTEN issued");

    expect(clients[0]?.connectionString).toBe("postgresql://test/db");
    expect(clients[0]?.queries).toEqual(["LISTEN bv_event"]);
    await listener.stop();
  });

  it("reconnects with a fresh client after the connection ends", async () => {
    const { listener } = makeListener();
    listener.start();
    await until(() => clients.length === 1, "first connect");

    clients[0]!.emit("end");
    await until(() => clients.length === 2, "reconnect");

    expect(clients[1]).not.toBe(clients[0]);
    expect(clients[1]?.queries).toEqual(["LISTEN bv_event"]);
    await listener.stop();
  });

  it("treats a socket error as a disconnect and reconnects", async () => {
    const { listener } = makeListener();
    listener.start();
    await until(() => clients.length === 1, "first connect");

    clients[0]!.emit("error", new Error("ECONNRESET"));
    await until(() => clients.length === 2, "reconnect after error");

    expect(errorSpy).toHaveBeenCalledWith(
      "[SseListener] client error:",
      "ECONNRESET",
    );
    await listener.stop();
  });

  it("logs a failed connect and retries rather than crashing", async () => {
    const { listener } = makeListener();
    // The mocked Client is constructed inside connectOnce, so arm the
    // failure by patching the prototype for the first attempt only.
    const realConnect = FakeClient.prototype.connect;
    let attempts = 0;
    FakeClient.prototype.connect = async function (this: FakeClient) {
      attempts++;
      if (attempts === 1) throw new Error("ECONNREFUSED");
      return realConnect.call(this);
    };

    try {
      listener.start();
      await until(() => clients.length === 2, "retry after failed connect");
      expect(errorSpy).toHaveBeenCalledWith(
        "[SseListener] connect failed:",
        "ECONNREFUSED",
      );
      expect(clients[1]?.queries).toEqual(["LISTEN bv_event"]);
    } finally {
      FakeClient.prototype.connect = realConnect;
      await listener.stop();
    }
  });

  it("stops the loop and ends the client on stop()", async () => {
    const { listener } = makeListener();
    listener.start();
    await until(() => clients.length === 1, "first connect");

    await listener.stop();
    const countAtStop = clients.length;
    await tick(20);

    expect(clients[0]?.ended).toBe(true);
    expect(clients.length).toBe(countAtStop);
  });

  it("swallows an end() failure from an already-dropped client", async () => {
    const { listener } = makeListener();
    listener.start();
    await until(() => clients.length === 1, "first connect");
    clients[0]!.endError = new Error("Client was closed and is not queryable");

    await expect(listener.stop()).resolves.toBeUndefined();
  });

  it("is idempotent across repeated stops", async () => {
    const { listener } = makeListener();
    listener.start();
    await until(() => clients.length === 1, "first connect");
    await listener.stop();
    await expect(listener.stop()).resolves.toBeUndefined();
  });

  it("refuses to restart once stopped", async () => {
    const { listener } = makeListener();
    await listener.stop();
    expect(() => listener.start()).toThrow(/cannot start a stopped listener/);
  });
});

describe("SseListener notification handling", () => {
  async function started(
    opts: Parameters<typeof makeListener>[0] = {},
  ): Promise<Harness & { client: FakeClient }> {
    const h = makeListener(opts);
    h.listener.start();
    await until(() => clients.length === 1, "connect");
    return { ...h, client: clients[0]! };
  }

  it("publishes a parsed event to the owners the lookup resolves", async () => {
    const h = await started({ owners: ["per_a", "per_b"] });
    h.client.notify(
      "bv_event",
      JSON.stringify({ event: "task.updated", id: "task_1" }),
    );
    await until(() => h.published.length === 1, "publish");

    expect(h.ownersOf).toHaveBeenCalledWith({
      event: "task.updated",
      id: "task_1",
    });
    expect(h.published[0]?.event).toEqual({
      event: "task.updated",
      id: "task_1",
    });
    expect([...h.published[0]!.owners]).toEqual(["per_a", "per_b"]);
    await h.listener.stop();
  });

  it("forwards an inline data payload for push-style events", async () => {
    const h = await started();
    h.client.notify(
      "bv_event",
      JSON.stringify({
        event: "session.step",
        id: "sess_1",
        data: { kind: "tool_use", tool_name: "Bash" },
      }),
    );
    await until(() => h.published.length === 1, "publish");

    expect(h.published[0]?.event).toEqual({
      event: "session.step",
      id: "sess_1",
      data: { kind: "tool_use", tool_name: "Bash" },
    });
    await h.listener.stop();
  });

  it.each([
    ["null", null],
    ["an array", ["a"]],
    ["a scalar", "nope"],
  ])("drops a non-object data field (%s)", async (_label, data) => {
    const h = await started();
    h.client.notify(
      "bv_event",
      JSON.stringify({ event: "task.updated", id: "task_1", data }),
    );
    await until(() => h.published.length === 1, "publish");

    expect(h.published[0]?.event).toEqual({
      event: "task.updated",
      id: "task_1",
    });
    await h.listener.stop();
  });

  it.each([
    ["another channel", "other_channel", JSON.stringify({ event: "a", id: "b" })],
    ["an empty payload", "bv_event", ""],
    ["a missing payload", "bv_event", undefined],
    ["malformed JSON", "bv_event", "{not json"],
    ["a missing id", "bv_event", JSON.stringify({ event: "task.updated" })],
    ["a missing event", "bv_event", JSON.stringify({ id: "task_1" })],
    [
      "a non-string id",
      "bv_event",
      JSON.stringify({ event: "task.updated", id: 7 }),
    ],
  ])("ignores %s", async (_label, channel, payload) => {
    const h = await started();
    h.client.notify(channel, payload);
    await tick(10);

    expect(h.published).toHaveLength(0);
    expect(h.seen).toHaveLength(0);
    expect(h.ownersOf).not.toHaveBeenCalled();
    await h.listener.stop();
  });

  it("fires onEvent without waiting on the owner lookup", async () => {
    // MeshServer's fast-fail path hangs off onEvent, so a slow owner
    // query must not gate it. Hold the lookup open and assert onEvent
    // has already fired.
    let releaseLookup: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const h = makeListener();
    h.ownersOf.mockImplementation(async () => {
      await held;
      return new Set(["per_1"]);
    });
    h.listener.start();
    await until(() => clients.length === 1, "connect");

    clients[0]!.notify(
      "bv_event",
      JSON.stringify({ event: "session.terminated", id: "sess_1" }),
    );

    expect(h.seen).toEqual([{ event: "session.terminated", id: "sess_1" }]);
    await tick(10);
    expect(h.published).toHaveLength(0);

    releaseLookup();
    await until(() => h.published.length === 1, "publish once lookup resolves");
    await h.listener.stop();
  });

  it("logs a throwing onEvent subscriber and still fans out to SSE", async () => {
    const h = await started({
      onEvent: () => {
        throw new Error("mesh handler blew up");
      },
    });

    h.client.notify(
      "bv_event",
      JSON.stringify({ event: "session.terminated", id: "sess_1" }),
    );
    await until(() => h.published.length === 1, "publish despite throw");

    expect(errorSpy).toHaveBeenCalledWith(
      "[SseListener] onEvent subscriber threw:",
      "mesh handler blew up",
    );
    await h.listener.stop();
  });

  it("still publishes when no onEvent subscriber is configured", async () => {
    const published: Array<{ event: unknown; owners: ReadonlySet<string> }> = [];
    const listener = new SseListener({
      databaseUrl: "postgresql://test/db",
      manager: {
        publish: (event: unknown, owners: ReadonlySet<string>) =>
          published.push({ event, owners }),
      } as never,
      ownerLookup: { ownersOf: async () => new Set(["per_1"]) } as never,
      reconnectDelayMs: 1,
    });
    listener.start();
    await until(() => clients.length === 1, "connect");

    clients[0]!.notify(
      "bv_event",
      JSON.stringify({ event: "task.updated", id: "task_1" }),
    );
    await until(() => published.length === 1, "publish");
    await listener.stop();
  });

  it("keeps listening on the reconnected client", async () => {
    const h = await started();
    h.client.emit("end");
    await until(() => clients.length === 2, "reconnect");

    clients[1]!.notify(
      "bv_event",
      JSON.stringify({ event: "task.updated", id: "task_2" }),
    );
    await until(() => h.published.length === 1, "publish after reconnect");

    expect(h.published[0]?.event).toMatchObject({ id: "task_2" });
    await h.listener.stop();
  });
});
