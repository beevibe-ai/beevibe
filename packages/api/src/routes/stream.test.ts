/**
 * Tests for `GET /stream` — the SSE live-update route the web client
 * holds open to receive `bv_event` fan-out.
 *
 * SSE is a lifecycle, not a request/response, so these run against a
 * real `http.Server` on an ephemeral port and read the socket directly.
 * That's the only way to exercise what actually matters here: the
 * headers proxies depend on, the priming `data: {}` line, the
 * subscribe/send wiring, the heartbeat, and — most importantly — that
 * a dropped client clears the interval and unsubscribes. A leak in that
 * cleanup is a server-lifetime leak, so it's asserted rather than
 * assumed.
 *
 * `SseManager` is a vitest fake; its own fan-out logic is covered by
 * the sse/ suite.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import express, { type RequestHandler } from "express";
import http from "node:http";
import { createStreamRouter, type StreamRoutesDeps } from "./stream.js";
import type { BvEvent } from "../sse/manager.js";

const PERSON = "per_alice";

function callerAs(caller: unknown): RequestHandler {
  return (req, _res, next) => {
    if (caller !== null) (req as { caller?: unknown }).caller = caller;
    next();
  };
}

interface Harness {
  url: string;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  /** The `send` callback the route handed to SseManager.subscribe. */
  sent: () => (event: BvEvent) => void;
  close: () => Promise<void>;
}

const servers: http.Server[] = [];

async function harness(caller: unknown = { source: "human", personId: PERSON }): Promise<Harness> {
  const unsubscribe = vi.fn();
  let captured: ((event: BvEvent) => void) | undefined;
  const subscribe = vi.fn((_personId: string, send: (e: BvEvent) => void) => {
    captured = send;
    return unsubscribe;
  });

  const deps: StreamRoutesDeps = {
    authMiddleware: callerAs(caller),
    sseManager: { subscribe } as never,
  };

  const app = express();
  app.use("/api", createStreamRouter(deps));
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");

  return {
    url: `http://127.0.0.1:${addr.port}/api/stream`,
    subscribe,
    unsubscribe,
    sent: () => {
      if (!captured) throw new Error("subscribe was never called");
      return captured;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Open the stream and resolve once the priming frame has arrived. */
function open(url: string): Promise<{
  res: http.IncomingMessage;
  req: http.ClientRequest;
  chunks: string[];
  /** Resolve once the buffered body contains `needle`. */
  waitFor: (needle: string) => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: string[] = [];
      const waiters: Array<{ needle: string; resolve: () => void }> = [];
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        chunks.push(c);
        const body = chunks.join("");
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (body.includes(waiters[i]!.needle)) {
            waiters.splice(i, 1)[0]!.resolve();
          }
        }
      });
      const waitFor = (needle: string) =>
        new Promise<void>((res2, rej2) => {
          if (chunks.join("").includes(needle)) return res2();
          const timer = setTimeout(
            () => rej2(new Error(`timed out waiting for ${JSON.stringify(needle)}`)),
            5_000,
          );
          waiters.push({
            needle,
            resolve: () => {
              clearTimeout(timer);
              res2();
            },
          });
        });
      waitFor("data: {}").then(
        () => resolve({ res, req, chunks, waitFor }),
        reject,
      );
    });
    req.on("error", reject);
  });
}

afterEach(async () => {
  vi.useRealTimers();
  while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
});

describe("GET /stream", () => {
  it("rejects a non-human caller with 403 and never subscribes", async () => {
    const h = await harness({ source: "agent", personId: PERSON, agentId: "agt_1" });
    const body = await new Promise<{ status?: number; text: string }>((resolve, reject) => {
      http
        .get(h.url, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode, text }));
        })
        .on("error", reject);
    });
    expect(body.status).toBe(403);
    expect(JSON.parse(body.text).error).toBe("human_required");
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it("sends the SSE headers proxies need, then a priming data frame", async () => {
    const h = await harness();
    const { res, req, chunks } = await open(h.url);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    // An SSE comment wouldn't fire onmessage in the browser, so the
    // priming frame has to be a data line.
    expect(chunks.join("")).toBe("data: {}\n\n");
    req.destroy();
  });

  it("subscribes the caller's person id to the fan-out", async () => {
    const h = await harness();
    const { req } = await open(h.url);
    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.subscribe.mock.calls[0]?.[0]).toBe(PERSON);
    req.destroy();
  });

  it("writes an event pushed through the subscription as one SSE frame", async () => {
    const h = await harness();
    const { req, waitFor, chunks } = await open(h.url);
    const event = { id: "evt_1", event: "task.updated", data: { task_id: "task_9" } };
    h.sent()(event as never);
    await waitFor("evt_1");
    expect(chunks.join("")).toBe(`data: {}\n\ndata: ${JSON.stringify(event)}\n\n`);
    req.destroy();
  });

  it("writes each of several events as its own frame, in order", async () => {
    const h = await harness();
    const { req, waitFor, chunks } = await open(h.url);
    const send = h.sent();
    send({ id: "evt_1", event: "a" } as never);
    send({ id: "evt_2", event: "b" } as never);
    await waitFor("evt_2");
    const frames = chunks.join("").trimEnd().split("\n\n");
    expect(frames).toEqual([
      "data: {}",
      'data: {"id":"evt_1","event":"a"}',
      'data: {"id":"evt_2","event":"b"}',
    ]);
    req.destroy();
  });

  it("clears the heartbeat and unsubscribes when the client disconnects", async () => {
    const clearSpy = vi.spyOn(global, "clearInterval");
    const h = await harness();
    const { req } = await open(h.url);
    expect(h.unsubscribe).not.toHaveBeenCalled();
    req.destroy();
    // `close` fires on a later turn of the loop; poll rather than sleep a
    // fixed amount so this doesn't depend on timing.
    const deadline = Date.now() + 5_000;
    while (h.unsubscribe.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    expect(h.unsubscribe).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("cleans up idempotently — req and res both fire 'close'", async () => {
    // The handler registers `cleanup` on both `req` and `res`, so it runs
    // more than once per disconnect. That is safe only because both halves
    // are no-ops the second time (clearInterval on a cleared timer;
    // SseManager's unsubscribe is a Set.delete). Pinned so a future
    // unsubscribe with side effects doesn't silently double-fire.
    const h = await harness();
    const { req } = await open(h.url);
    req.destroy();
    const deadline = Date.now() + 5_000;
    while (h.unsubscribe.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    // Let any second `close` land before counting.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(h.unsubscribe.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Every call is the same zero-arg unsubscribe for this connection.
    for (const call of h.unsubscribe.mock.calls) expect(call).toEqual([]);
  });

  it("subscribes once per connection", async () => {
    const h = await harness();
    const a = await open(h.url);
    const b = await open(h.url);
    expect(h.subscribe).toHaveBeenCalledTimes(2);
    a.req.destroy();
    b.req.destroy();
  });

  it("registers a 25s heartbeat that writes an SSE comment", async () => {
    // Driving a real 25s interval would mean a 25s test, and swapping in
    // fake timers mid-connection can't reach an interval the handler
    // already created with the real one. So capture the handler's own
    // interval callback and invoke it — the assertion is still on the
    // bytes that reach the socket.
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    const spy = vi
      .spyOn(global, "setInterval")
      .mockImplementation(((fn: () => void, ms: number) => {
        intervals.push({ fn, ms });
        return { unref: () => {} } as never;
      }) as never);

    const h = await harness();
    const { req, waitFor, chunks } = await open(h.url);
    spy.mockRestore();

    const heartbeat = intervals.find((i) => i.ms === 25_000);
    expect(heartbeat).toBeDefined();
    heartbeat!.fn();
    await waitFor(": heartbeat");
    // A comment line, not a data frame — it must not fire the browser's
    // onmessage, only keep the proxy from idling the connection out.
    expect(chunks.join("")).toBe("data: {}\n\n: heartbeat\n\n");
    req.destroy();
  });
});
