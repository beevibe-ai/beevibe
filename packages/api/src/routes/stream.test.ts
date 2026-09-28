/**
 * GET /api/stream — the browser's SSE pipe. Exercised against a real
 * http server and a real `SseManager`, because everything that can go
 * wrong here is protocol-level and invisible to a mocked `res`:
 *
 *   - the SSE headers (a missing `no-transform` or `X-Accel-Buffering`
 *     is how a proxy silently buffers the stream into uselessness)
 *   - the priming `data: {}` line, without which the client's onmessage
 *     never fires and its health probe never trips
 *   - per-person fanout, which is the only thing keeping one user's
 *     events out of another's EventSource
 *   - cleanup on disconnect — a leaked heartbeat interval writes to a
 *     dead socket every 25s for the life of the process
 */
import {
  createServer,
  get as httpGet,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SseManager, type BvEvent } from "../sse/manager.js";
import { createStreamRouter } from "./stream.js";

const PERSON = "person_1";
const OTHER = "person_2";

function makeEvent(overrides: Partial<BvEvent> = {}): BvEvent {
  return { event: "task.updated", id: "task_1", ...overrides };
}

/** Auth stub: whatever `caller` holds at request time is attached. */
function authStub(caller: () => unknown): RequestHandler {
  return (req, _res, next) => {
    (req as unknown as { caller: unknown }).caller = caller();
    next();
  };
}

describe("createStreamRouter", () => {
  it("refuses a non-human caller with 403 human_required", async () => {
    const sseManager = new SseManager();
    const subscribe = vi.spyOn(sseManager, "subscribe");
    const app = express().use(
      "/api",
      createStreamRouter({
        authMiddleware: authStub(() => ({
          source: "agent",
          agentId: "agent_1",
        })),
        sseManager,
      }),
    );
    const res = await request(app).get("/api/stream");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("GET /api/stream (live socket)", () => {
  let server: Server;
  let sseManager: SseManager;
  let caller: unknown;
  /** Interval handles the route registered, newest last. */
  let intervals: { ms: number; fire: () => void; handle: unknown }[];
  let clearedHandles: unknown[];
  const open: IncomingMessage[] = [];

  beforeEach(async () => {
    sseManager = new SseManager();
    caller = { source: "human", personId: PERSON };
    intervals = [];
    clearedHandles = [];

    // Park the route's 25s heartbeat so a test can fire it on demand;
    // every other timer (supertest, express, this file's own polling)
    // keeps real behaviour, which fake timers would not allow.
    const realSetInterval = globalThis.setInterval as unknown as (
      ...args: unknown[]
    ) => NodeJS.Timeout;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms === 25_000) {
        const handle = { parked: true };
        intervals.push({ ms, fire: fn, handle });
        return handle as unknown as NodeJS.Timeout;
      }
      return realSetInterval(fn, ms, ...rest);
    }) as typeof globalThis.setInterval);

    const realClearInterval = globalThis.clearInterval as unknown as (
      handle: unknown,
    ) => void;
    vi.spyOn(globalThis, "clearInterval").mockImplementation(((
      handle: unknown,
    ) => {
      clearedHandles.push(handle);
      if (intervals.some((i) => i.handle === handle)) return;
      realClearInterval(handle);
    }) as typeof globalThis.clearInterval);

    const app = express().use(
      "/api",
      createStreamRouter({
        authMiddleware: authStub(() => caller),
        sseManager,
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    for (const res of open.splice(0)) res.destroy();
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * Open a stream and resolve once the priming `data: {}` has landed, so
   * every test starts from a connected, subscribed socket.
   */
  async function openStream(): Promise<{
    res: IncomingMessage;
    chunks: string[];
    /** Wait until the accumulated body contains `needle`. */
    waitFor: (needle: string) => Promise<void>;
  }> {
    const port = (server.address() as AddressInfo).port;
    const chunks: string[] = [];
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpGet(`http://127.0.0.1:${port}/api/stream`, resolve);
      req.on("error", reject);
    });
    open.push(res);
    res.setEncoding("utf8");
    res.on("data", (c: string) => chunks.push(c));

    const waitFor = async (needle: string): Promise<void> => {
      const deadline = Date.now() + 2_000;
      while (!chunks.join("").includes(needle)) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(chunks.join(""))}`,
          );
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    await waitFor("data: {}\n\n");
    return { res, chunks, waitFor };
  }

  it("sends the SSE headers proxies need to leave the stream alone", async () => {
    const { res } = await openStream();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");
    expect(res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(res.headers["connection"]).toBe("keep-alive");
    expect(res.headers["x-accel-buffering"]).toBe("no");
  });

  it("primes the connection with a data line, not just a comment", async () => {
    const { chunks } = await openStream();
    // A `: comment` would never fire the browser's onmessage, so the
    // client's health probe would never trip before the first event.
    expect(chunks.join("")).toBe("data: {}\n\n");
  });

  it("subscribes under the caller's personId and forwards their events", async () => {
    const { chunks, waitFor } = await openStream();
    const event = makeEvent({ event: "session.step", id: "sess_1" });
    sseManager.publish(event, new Set([PERSON]));
    await waitFor(JSON.stringify(event));
    expect(chunks.join("")).toBe(`data: {}\n\ndata: ${JSON.stringify(event)}\n\n`);
  });

  it("does not forward another person's events", async () => {
    const { chunks } = await openStream();
    sseManager.publish(makeEvent(), new Set([OTHER]));
    // Nothing to wait for — give the fanout a tick and assert silence.
    await new Promise((r) => setTimeout(r, 20));
    expect(chunks.join("")).toBe("data: {}\n\n");
  });

  it("writes a heartbeat comment every 25s", async () => {
    const { chunks, waitFor } = await openStream();
    expect(intervals).toHaveLength(1);
    expect(intervals[0]!.ms).toBe(25_000);
    intervals[0]!.fire();
    await waitFor(": heartbeat\n\n");
    expect(chunks.join("")).toBe("data: {}\n\n: heartbeat\n\n");
  });

  it("clears the heartbeat and unsubscribes when the client disconnects", async () => {
    const { res } = await openStream();
    const handle = intervals[0]!.handle;
    res.destroy();

    const deadline = Date.now() + 2_000;
    while (!clearedHandles.includes(handle)) {
      if (Date.now() > deadline) throw new Error("heartbeat interval never cleared");
      await new Promise((r) => setTimeout(r, 5));
    }
    // Unsubscribed too: a publish to this person must reach nobody, and
    // must not throw by writing to the dead socket.
    expect(() =>
      sseManager.publish(makeEvent(), new Set([PERSON])),
    ).not.toThrow();
  });

  it("gives each connection its own subscription and heartbeat", async () => {
    const a = await openStream();
    const b = await openStream();
    expect(intervals).toHaveLength(2);
    const event = makeEvent({ id: "task_shared" });
    sseManager.publish(event, new Set([PERSON]));
    await a.waitFor(JSON.stringify(event));
    await b.waitFor(JSON.stringify(event));
  });

  it("scopes a second viewer to their own personId", async () => {
    const mine = await openStream();
    caller = { source: "human", personId: OTHER };
    const theirs = await openStream();

    const event = makeEvent({ id: "task_theirs" });
    sseManager.publish(event, new Set([OTHER]));
    await theirs.waitFor(JSON.stringify(event));
    expect(mine.chunks.join("")).toBe("data: {}\n\n");
  });
});
