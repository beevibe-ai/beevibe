/**
 * GET /stream (SSE) — driven over a real loopback socket.
 *
 * supertest buffers until the response ends, and this response never
 * does, so the tests open an actual `http.get` and read the raw frames
 * off the wire. That's also what makes the assertions worth having:
 * the headers (`no-transform`, `X-Accel-Buffering: no`) and the
 * priming `data: {}` line are a contract with proxies and with the
 * browser's `onmessage` health probe — a plain function-level test
 * would not see them.
 *
 * Only the interval timers are faked, so the heartbeat can be driven
 * without stalling the socket.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BvEvent, SseManager } from "../sse/manager.js";
import { createStreamRouter } from "./stream.js";

const PERSON = "person_1";

function stubAuth(source: "human" | "agent") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (source === "human") {
      req.caller = {
        source: "human",
        agentId: "agent_a",
        hierarchyLevel: "team",
        personId: PERSON,
      };
    } else {
      req.caller = { source: "agent", agentId: "agent_a", hierarchyLevel: "ic" };
    }
    next();
  };
}

interface Harness {
  /** Resolves with the live response once headers arrive. */
  res: http.IncomingMessage;
  /** Everything received so far, as one string. */
  body: () => string;
  /** The callback `subscribe` was handed, i.e. the fanout entry point. */
  send: (event: BvEvent) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  close: () => Promise<void>;
}

const open: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
  vi.useRealTimers();
});

async function connect(source: "human" | "agent" = "human"): Promise<Harness> {
  const unsubscribe = vi.fn();
  let captured: ((event: BvEvent) => void) | undefined;
  const subscribe = vi.fn((_personId: string, cb: (event: BvEvent) => void) => {
    captured = cb;
    return unsubscribe;
  });
  const sseManager = { subscribe } as unknown as SseManager;

  const app = express();
  app.use("/", createStreamRouter({ authMiddleware: stubAuth(source), sseManager }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;

  const res = await new Promise<http.IncomingMessage>((resolve) => {
    http.get(`http://127.0.0.1:${port}/stream`, resolve);
  });
  let buf = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    buf += chunk;
  });

  const harness: Harness = {
    res,
    body: () => buf,
    send: (event) => captured?.(event),
    unsubscribe,
    subscribe,
    close: async () => {
      res.destroy();
      await new Promise((r) => server.close(r));
    },
  };
  open.push(harness.close);
  return harness;
}

/** Spin the event loop until `check` passes or the budget runs out. */
async function until(check: () => boolean, label: string, ticks = 200): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    if (check()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("GET /stream", () => {
  it("403s a non-human caller without subscribing", async () => {
    const h = await connect("agent");
    expect(h.res.statusCode).toBe(403);
    await until(() => h.body().length > 0, "the 403 body");
    expect(JSON.parse(h.body()).error).toBe("human_required");
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it("opens an event-stream with the proxy-defeating headers", async () => {
    const h = await connect();
    expect(h.res.statusCode).toBe(200);
    expect(h.res.headers["content-type"]).toBe("text/event-stream");
    // `no-transform` and `X-Accel-Buffering: no` are what stop nginx /
    // cloudflared from buffering the stream into uselessness.
    expect(h.res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(h.res.headers["x-accel-buffering"]).toBe("no");
    expect(h.res.headers.connection).toBe("keep-alive");
  });

  it("primes the stream with an empty data event", async () => {
    const h = await connect();
    await until(() => h.body().includes("data:"), "the priming event");
    // A comment line wouldn't fire the browser's onmessage, so this has
    // to be a data line; `{}` parses but fails the client's filter.
    expect(h.body()).toBe("data: {}\n\n");
  });

  it("subscribes the authenticated person and forwards fanned-out events", async () => {
    const h = await connect();
    await until(() => h.subscribe.mock.calls.length > 0, "the subscribe call");
    expect(h.subscribe.mock.calls[0]?.[0]).toBe(PERSON);

    h.send({ event: "task.updated", id: "task_1" });
    h.send({ event: "session.step", id: "sess_1", data: { kind: "tool_call" } });
    await until(() => h.body().includes("session.step"), "both events");
    expect(h.body()).toBe(
      "data: {}\n\n" +
        'data: {"event":"task.updated","id":"task_1"}\n\n' +
        'data: {"event":"session.step","id":"sess_1","data":{"kind":"tool_call"}}\n\n',
    );
  });

  it("writes a heartbeat comment every 25s", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const h = await connect();
    await until(() => h.body().includes("data:"), "the priming event");

    vi.advanceTimersByTime(25_000);
    await until(() => h.body().includes(": heartbeat"), "the first heartbeat");
    vi.advanceTimersByTime(25_000);
    await until(
      () => h.body().split(": heartbeat").length === 3,
      "the second heartbeat",
    );
  });

  it("unsubscribes and stops the heartbeat when the client disconnects", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const h = await connect();
    await until(() => h.subscribe.mock.calls.length > 0, "the subscribe call");

    h.res.destroy();
    await until(() => h.unsubscribe.mock.calls.length > 0, "the unsubscribe call");

    // The interval is cleared, so no further writes are attempted on the
    // dead socket (an un-cleared one would throw ERR_STREAM_WRITE_AFTER_END).
    const before = h.body();
    vi.advanceTimersByTime(100_000);
    await new Promise((r) => setImmediate(r));
    expect(h.body()).toBe(before);
  });
});
