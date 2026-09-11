/**
 * GET /stream — the SSE fanout route, exercised over a real socket.
 *
 * Everything this route does is invisible to a normal JSON assertion:
 * the headers that stop proxies from buffering, the priming `data: {}`
 * line that trips the browser's health probe, the 25s heartbeat that
 * keeps nginx/cloudflared from idling the connection out, and the
 * unsubscribe-on-disconnect that stops the subscriber set from leaking
 * a closed response. So the tests drive a real http server and read the
 * raw bytes off the wire.
 *
 * Intervals are faked (and only intervals) so the heartbeat is
 * assertable without a 25-second test.
 */

import { createServer, get as httpGet, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BvEvent, SseManager } from "../sse/manager.js";
import { createStreamRouter } from "./stream.js";

const PERSON = "person_1";

interface CapturedSubscriber {
  personId: string;
  send: (event: BvEvent) => void;
  active: boolean;
}

function fakeSseManager(): {
  manager: SseManager;
  subs: CapturedSubscriber[];
} {
  const subs: CapturedSubscriber[] = [];
  const manager = {
    subscribe(personId: string, cb: (event: BvEvent) => void) {
      const entry: CapturedSubscriber = { personId, send: cb, active: true };
      subs.push(entry);
      return () => {
        entry.active = false;
      };
    },
  } as unknown as SseManager;
  return { manager, subs };
}

/** Auth middleware stand-in: stamps whatever caller the test wants. */
function authAs(caller: unknown): RequestHandler {
  return (req, _res, next) => {
    (req as unknown as { caller: unknown }).caller = caller;
    next();
  };
}

const HUMAN = { source: "human", personId: PERSON };

interface Harness {
  server: Server;
  port: number;
  subs: CapturedSubscriber[];
}

async function startServer(caller: unknown): Promise<Harness> {
  const { manager, subs } = fakeSseManager();
  const app = express();
  app.use(createStreamRouter({ authMiddleware: authAs(caller), sseManager: manager }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port, subs };
}

/**
 * Open the SSE connection and hand back a reader that resolves the next
 * chunk of the stream — the only way to assert on a response that never
 * ends.
 */
interface Stream {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Resolves with the next chunk written by the server. */
  next(): Promise<string>;
  close(): void;
  closed: Promise<void>;
}

function open(port: number): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = httpGet(
      { host: "127.0.0.1", port, path: "/stream" },
      (res) => {
        const queued: string[] = [];
        let pending: ((chunk: string) => void) | undefined;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (pending) {
            const resolveNext = pending;
            pending = undefined;
            resolveNext(chunk);
          } else {
            queued.push(chunk);
          }
        });
        let markClosed = (): void => undefined;
        const closed = new Promise<void>((r) => {
          markClosed = r;
        });
        res.on("close", () => markClosed());
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          next: () =>
            new Promise<string>((r) => {
              const queuedChunk = queued.shift();
              if (queuedChunk !== undefined) r(queuedChunk);
              else pending = r;
            }),
          close: () => req.destroy(),
          closed,
        });
      },
    );
    req.on("error", reject);
  });
}

/** Poll until `predicate` holds — the server-side close is asynchronous. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error("condition never became true");
}

describe("GET /stream", () => {
  let harness: Harness | undefined;
  const opened: Stream[] = [];

  /** Open a stream the teardown will always tear down. */
  async function connect(port: number): Promise<Stream> {
    const stream = await open(port);
    opened.push(stream);
    return stream;
  }

  beforeEach(() => {
    // Only intervals: real socket I/O and setImmediate must keep working.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    // An SSE response never ends on its own, so server.close() would hang
    // forever if a connection were left open.
    for (const stream of opened.splice(0)) stream.close();
    if (harness) {
      harness.server.closeAllConnections();
      await new Promise<void>((resolve) => harness!.server.close(() => resolve()));
      harness = undefined;
    }
  });

  it("sends the SSE headers that keep proxies from buffering", async () => {
    harness = await startServer(HUMAN);
    const stream = await connect(harness.port);

    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toBe("text/event-stream");
    expect(stream.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(stream.headers["x-accel-buffering"]).toBe("no");

    stream.close();
  });

  it("primes the stream with an empty data event", async () => {
    harness = await startServer(HUMAN);
    const stream = await connect(harness.port);

    // A comment line would not fire the browser's onmessage, so the
    // health probe needs a real data line first.
    await expect(stream.next()).resolves.toBe("data: {}\n\n");

    stream.close();
  });

  it("subscribes the caller's own personId", async () => {
    harness = await startServer(HUMAN);
    const stream = await connect(harness.port);
    await stream.next();

    expect(harness.subs).toHaveLength(1);
    expect(harness.subs[0]!.personId).toBe(PERSON);

    stream.close();
  });

  it("writes a published event as a JSON data line", async () => {
    harness = await startServer(HUMAN);
    const stream = await connect(harness.port);
    await stream.next();

    const event: BvEvent = {
      event: "task.updated",
      id: "task_1",
      data: { status: "done" },
    };
    harness.subs[0]!.send(event);

    await expect(stream.next()).resolves.toBe(
      `data: ${JSON.stringify(event)}\n\n`,
    );

    stream.close();
  });

  it("writes a heartbeat comment every 25 seconds", async () => {
    harness = await startServer(HUMAN);
    const stream = await connect(harness.port);
    await stream.next();

    vi.advanceTimersByTime(25_000);
    await expect(stream.next()).resolves.toBe(": heartbeat\n\n");

    vi.advanceTimersByTime(25_000);
    await expect(stream.next()).resolves.toBe(": heartbeat\n\n");

    stream.close();
  });

  it("unsubscribes and clears the heartbeat when the client disconnects", async () => {
    harness = await startServer(HUMAN);
    const stream = await connect(harness.port);
    await stream.next();

    stream.close();
    await until(() => harness!.subs[0]!.active === false);

    // The interval is gone too: nothing is left to write to a dead socket.
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a non-human caller with 403 and never subscribes", async () => {
    harness = await startServer({ source: "agent", agentId: "agent_a" });
    const stream = await connect(harness.port);

    expect(stream.status).toBe(403);
    expect(harness.subs).toHaveLength(0);
    await stream.closed;
  });

  it("rejects a caller the auth middleware left unresolved", async () => {
    harness = await startServer(null);
    const stream = await connect(harness.port);

    expect(stream.status).toBe(403);
    expect(harness.subs).toHaveLength(0);
    await stream.closed;
  });
});
