/**
 * Tests for SseListener — the pg LISTEN client that feeds `bv_event`
 * notifications into SseManager.
 *
 * `pg.Client` is mocked with an EventEmitter stand-in so we can drive
 * `notification` / `end` / `error` by hand. That covers the three things
 * worth pinning down: the payload parser's accept/reject rules, the
 * onEvent side-channel's error isolation, and the reconnect loop's
 * lifecycle (reconnect on drop, no reconnect after stop()).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { BvEvent } from "./manager.js";

class FakeClient extends EventEmitter {
  static instances: FakeClient[] = [];
  static connectImpl: (() => Promise<void>) | undefined;

  readonly queries: string[] = [];
  readonly options: { connectionString?: string };
  connectCalls = 0;
  endCalls = 0;
  endImpl: (() => Promise<void>) | undefined;

  constructor(options: { connectionString?: string }) {
    super();
    this.options = options;
    FakeClient.instances.push(this);
  }

  async connect(): Promise<void> {
    this.connectCalls++;
    if (FakeClient.connectImpl) await FakeClient.connectImpl();
  }

  async query(sql: string): Promise<{ rows: never[] }> {
    this.queries.push(sql);
    return { rows: [] };
  }

  async end(): Promise<void> {
    this.endCalls++;
    if (this.endImpl) await this.endImpl();
    this.emit("end");
  }
}

vi.mock("pg", () => ({ Client: FakeClient }));

// Imported after vi.mock so the listener picks up FakeClient.
const { SseListener } = await import("./listener.js");

/** Yield to the microtask queue so the listener's awaits settle. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Poll until `predicate` holds. Reconnects go through a real
 * `setTimeout(reconnectDelayMs)`, which `setImmediate` outruns — so
 * anything asserting on a *subsequent* connection has to wait on the
 * clock rather than the microtask queue.
 */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

const reconnected = () =>
  until(() => FakeClient.instances.length > 1, "a second connection attempt");

function makeDeps() {
  const published: Array<{ event: BvEvent; owners: ReadonlySet<string> }> = [];
  const manager = {
    publish: vi.fn((event: BvEvent, owners: ReadonlySet<string>) => {
      published.push({ event, owners });
    }),
  };
  const ownerLookup = {
    ownersOf: vi.fn(async () => new Set(["per_1"]) as ReadonlySet<string>),
  };
  return { manager, ownerLookup, published };
}

/**
 * Start a listener and wait until its first client is connected and
 * LISTENing. Returns the listener plus that client.
 */
async function startListener(
  overrides: Record<string, unknown> = {},
): Promise<{
  listener: InstanceType<typeof SseListener>;
  client: FakeClient;
  deps: ReturnType<typeof makeDeps>;
}> {
  const deps = makeDeps();
  const listener = new SseListener({
    databaseUrl: "postgres://test/db",
    manager: deps.manager as never,
    ownerLookup: deps.ownerLookup as never,
    reconnectDelayMs: 1,
    ...overrides,
  });
  listener.start();
  await tick();
  return { listener, client: FakeClient.instances[0]!, deps };
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  FakeClient.instances = [];
  FakeClient.connectImpl = undefined;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("SseListener — connection lifecycle", () => {
  it("connects with the configured url and issues LISTEN bv_event", async () => {
    const { listener, client } = await startListener();
    expect(client.options.connectionString).toBe("postgres://test/db");
    expect(client.connectCalls).toBe(1);
    expect(client.queries).toEqual(["LISTEN bv_event"]);
    await listener.stop();
  });

  it("reconnects with a fresh client after the connection ends", async () => {
    const { listener, client } = await startListener();
    client.emit("end");
    await reconnected();
    expect(FakeClient.instances[1]!.queries).toEqual(["LISTEN bv_event"]);
    await listener.stop();
  });

  it("logs and reconnects after a socket-level client error", async () => {
    const { listener, client } = await startListener();
    client.emit("error", new Error("ECONNRESET"));
    await reconnected();
    expect(errorSpy).toHaveBeenCalledWith(
      "[SseListener] client error:",
      "ECONNRESET",
    );
    await listener.stop();
  });

  it("logs a failed connect and retries rather than throwing", async () => {
    FakeClient.connectImpl = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const { listener } = await startListener();
    await reconnected();
    expect(errorSpy).toHaveBeenCalledWith(
      "[SseListener] connect failed:",
      "connection refused",
    );
    await listener.stop();
  });

  it("stop() ends the live client and halts the reconnect loop", async () => {
    const { listener, client } = await startListener();
    await listener.stop();
    expect(client.endCalls).toBe(1);

    // Wait well past the 1ms reconnect delay — nothing should reconnect.
    const countAfterStop = FakeClient.instances.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(FakeClient.instances.length).toBe(countAfterStop);
  });

  it("stop() swallows an end() that rejects because the socket is already gone", async () => {
    const { listener, client } = await startListener();
    client.endImpl = async () => {
      throw new Error("already disconnected");
    };
    await expect(listener.stop()).resolves.toBeUndefined();
  });

  it("stop() is idempotent", async () => {
    const { listener, client } = await startListener();
    await listener.stop();
    await listener.stop();
    expect(client.endCalls).toBe(1);
  });

  it("refuses to start a listener that has been stopped", async () => {
    const { listener } = await startListener();
    await listener.stop();
    expect(() => listener.start()).toThrow(/cannot start a stopped listener/);
  });
});

describe("SseListener — notification routing", () => {
  it("publishes a parsed event to the owners resolved by OwnerLookup", async () => {
    const { listener, client, deps } = await startListener();
    client.emit("notification", {
      channel: "bv_event",
      payload: JSON.stringify({ event: "task.updated", id: "tsk_1" }),
    });
    await tick();
    expect(deps.ownerLookup.ownersOf).toHaveBeenCalledWith({
      event: "task.updated",
      id: "tsk_1",
    });
    expect(deps.manager.publish).toHaveBeenCalledWith(
      { event: "task.updated", id: "tsk_1" },
      new Set(["per_1"]),
    );
    await listener.stop();
  });

  it("forwards an inline data payload when the event carries one", async () => {
    const { listener, client, deps } = await startListener();
    client.emit("notification", {
      channel: "bv_event",
      payload: JSON.stringify({
        event: "session.step",
        id: "sess_1",
        data: { kind: "tool_use", tool_name: "Read" },
      }),
    });
    await tick();
    expect(deps.published[0]!.event).toEqual({
      event: "session.step",
      id: "sess_1",
      data: { kind: "tool_use", tool_name: "Read" },
    });
    await listener.stop();
  });

  it("ignores notifications on other channels and empty payloads", async () => {
    const { listener, client, deps } = await startListener();
    client.emit("notification", {
      channel: "other_channel",
      payload: JSON.stringify({ event: "task.updated", id: "tsk_1" }),
    });
    client.emit("notification", { channel: "bv_event", payload: "" });
    client.emit("notification", { channel: "bv_event" });
    await tick();
    expect(deps.manager.publish).not.toHaveBeenCalled();
    await listener.stop();
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a missing id", JSON.stringify({ event: "task.updated" })],
    ["a missing event name", JSON.stringify({ id: "tsk_1" })],
    ["a non-string id", JSON.stringify({ event: "task.updated", id: 7 })],
    ["a non-string event name", JSON.stringify({ event: 7, id: "tsk_1" })],
    ["a JSON scalar", "42"],
  ])("drops a payload with %s", async (_label, payload) => {
    const { listener, client, deps } = await startListener();
    client.emit("notification", { channel: "bv_event", payload });
    await tick();
    expect(deps.manager.publish).not.toHaveBeenCalled();
    await listener.stop();
  });

  it.each([
    ["an array", JSON.stringify({ event: "e", id: "i", data: [1, 2] })],
    ["null", JSON.stringify({ event: "e", id: "i", data: null })],
    ["a scalar", JSON.stringify({ event: "e", id: "i", data: "nope" })],
  ])("omits a data field that is %s", async (_label, payload) => {
    const { listener, client, deps } = await startListener();
    client.emit("notification", { channel: "bv_event", payload });
    await tick();
    expect(deps.published[0]!.event).toEqual({ event: "e", id: "i" });
    await listener.stop();
  });
});

describe("SseListener — onEvent side channel", () => {
  it("fires onEvent synchronously, before the async owner fan-out", async () => {
    const order: string[] = [];
    const onEvent = vi.fn(() => {
      order.push("onEvent");
    });
    const { listener, client, deps } = await startListener({ onEvent });
    deps.manager.publish.mockImplementation(() => {
      order.push("publish");
    });

    client.emit("notification", {
      channel: "bv_event",
      payload: JSON.stringify({ event: "session.terminated", id: "sess_1" }),
    });
    // onEvent has already run; publish has not.
    expect(order).toEqual(["onEvent"]);

    await tick();
    expect(order).toEqual(["onEvent", "publish"]);
    await listener.stop();
  });

  it("does not fire onEvent for a payload that fails to parse", async () => {
    const onEvent = vi.fn();
    const { listener, client } = await startListener({ onEvent });
    client.emit("notification", { channel: "bv_event", payload: "{bad" });
    await tick();
    expect(onEvent).not.toHaveBeenCalled();
    await listener.stop();
  });

  it("logs an onEvent subscriber throw and still completes the fan-out", async () => {
    const onEvent = vi.fn(() => {
      throw new Error("subscriber blew up");
    });
    const { listener, client, deps } = await startListener({ onEvent });
    client.emit("notification", {
      channel: "bv_event",
      payload: JSON.stringify({ event: "session.terminated", id: "sess_1" }),
    });
    await tick();
    expect(errorSpy).toHaveBeenCalledWith(
      "[SseListener] onEvent subscriber threw:",
      "subscriber blew up",
    );
    expect(deps.manager.publish).toHaveBeenCalledTimes(1);
    await listener.stop();
  });
});
