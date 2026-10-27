/**
 * GET /stream — the browser's SSE channel, unit-tested with a fake
 * response object (no DB, no real socket).
 *
 * The route is short but every line of it is load-bearing in a way that
 * fails silently when broken: a missing `data: {}` priming event leaves
 * the client's health probe never firing, a missing heartbeat lets a
 * proxy idle the connection out, and a cleanup that doesn't unsubscribe
 * leaks a writer that then writes to a closed socket on every publish.
 * None of that surfaces in a happy-path integration run, so it is pinned
 * here directly.
 */
import express from "express";
import request from "supertest";
import type { Request, RequestHandler, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import type { BvEvent, SseManager, SseSubscriber } from "../sse/manager.js";
import { createStreamRouter } from "./stream.js";

const HUMAN: ResolvedCaller = {
  source: "human",
  personId: "person_1",
  agentId: "agent_top",
  hierarchyLevel: "team",
};

function fakeSseManager() {
  const unsubscribe = vi.fn();
  const subscribers: Array<{ personId: string; cb: SseSubscriber }> = [];
  const subscribe = vi.fn((personId: string, cb: SseSubscriber) => {
    subscribers.push({ personId, cb });
    return unsubscribe;
  });
  return {
    unsubscribe,
    subscribers,
    subscribe,
    manager: { subscribe } as unknown as SseManager,
  };
}

/**
 * Drives the handler with a stub `res`, because supertest's agent never
 * resolves against a stream that stays open — and the heartbeat and the
 * close-cleanup only exist on the open connection.
 */
function openStream(
  caller: ResolvedCaller | undefined = HUMAN,
  sse = fakeSseManager(),
) {
  const authMiddleware: RequestHandler = (req, _res, next) => {
    req.caller = caller;
    next();
  };
  const router = createStreamRouter({ authMiddleware, sseManager: sse.manager });

  const writes: string[] = [];
  const handlers = new Map<string, Array<() => void>>();
  const on = (name: string, fn: () => void) => {
    const list = handlers.get(name) ?? [];
    list.push(fn);
    handlers.set(name, list);
  };

  const res = {
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    status: vi.fn(() => res),
    json: vi.fn(() => res),
    on: vi.fn((name: string, fn: () => void) => on(name, fn)),
  } as unknown as Response & { writeHead: ReturnType<typeof vi.fn> };

  const req = {
    method: "GET",
    url: "/stream",
    caller,
    on: vi.fn((name: string, fn: () => void) => on(name, fn)),
  } as unknown as Request;

  // The router is express middleware; invoking it directly runs the
  // auth middleware then the GET handler, with no socket involved.
  const done = new Promise<void>((resolve) => {
    (router as unknown as (rq: Request, rs: Response, nx: () => void) => void)(
      req,
      res,
      resolve,
    );
  });

  return {
    sse,
    res,
    writes,
    done,
    fire: (name: string) => (handlers.get(name) ?? []).forEach((fn) => fn()),
    listeners: (name: string) => handlers.get(name)?.length ?? 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /stream auth", () => {
  it("403s a non-human caller without subscribing", async () => {
    const sse = fakeSseManager();
    const authMiddleware: RequestHandler = (req, _res, next) => {
      req.caller = { source: "agent", agentId: "agent_a", hierarchyLevel: "ic" };
      next();
    };
    const app = express().use(
      createStreamRouter({ authMiddleware, sseManager: sse.manager }),
    );

    const res = await request(app).get("/stream");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "human_required" });
    expect(sse.subscribe).not.toHaveBeenCalled();
  });

  it("403s when the middleware attached no caller at all", async () => {
    const sse = fakeSseManager();
    const authMiddleware: RequestHandler = (_req, _res, next) => next();
    const app = express().use(
      createStreamRouter({ authMiddleware, sseManager: sse.manager }),
    );

    const res = await request(app).get("/stream");

    expect(res.status).toBe(403);
    expect(sse.subscribe).not.toHaveBeenCalled();
  });
});

describe("GET /stream handshake", () => {
  it("sends the SSE headers browsers and proxies need", () => {
    const { res } = openStream();

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this nginx buffers the stream and nothing arrives until
      // the buffer fills.
      "X-Accel-Buffering": "no",
    });
  });

  it("flushes the headers immediately", () => {
    const { res } = openStream();
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  // SSE comments don't fire onmessage in the browser, so the priming
  // frame has to be a data line for the client's health probe to trip.
  it("primes the connection with an empty data event, not a comment", () => {
    const { writes } = openStream();

    expect(writes[0]).toBe("data: {}\n\n");
    expect(JSON.parse("{}")).toEqual({});
  });

  it("subscribes the caller's own personId", () => {
    const { sse } = openStream();

    expect(sse.subscribe).toHaveBeenCalledWith("person_1", expect.any(Function));
    expect(sse.subscribers[0]?.personId).toBe("person_1");
  });
});

describe("GET /stream fanout", () => {
  it("serializes each published event as one SSE data frame", () => {
    const { sse, writes } = openStream();
    const event: BvEvent = {
      event: "task.updated",
      id: "task_1",
      data: { status: "done" },
    };

    sse.subscribers[0]!.cb(event);

    expect(writes.at(-1)).toBe(`data: ${JSON.stringify(event)}\n\n`);
  });

  it("writes one frame per event, in order", () => {
    const { sse, writes } = openStream();

    sse.subscribers[0]!.cb({ event: "task.updated", id: "task_1" });
    sse.subscribers[0]!.cb({ event: "session.step", id: "sess_1" });

    // writes[0] is the priming frame.
    expect(writes.slice(1)).toEqual([
      'data: {"event":"task.updated","id":"task_1"}\n\n',
      'data: {"event":"session.step","id":"sess_1"}\n\n',
    ]);
  });
});

describe("GET /stream heartbeat", () => {
  it("emits a comment line every 25s", () => {
    const { writes } = openStream();

    vi.advanceTimersByTime(25_000);
    expect(writes.at(-1)).toBe(": heartbeat\n\n");

    vi.advanceTimersByTime(50_000);
    expect(writes.filter((w) => w === ": heartbeat\n\n")).toHaveLength(3);
  });

  it("has not fired before the interval elapses", () => {
    const { writes } = openStream();

    vi.advanceTimersByTime(24_999);
    expect(writes).toEqual(["data: {}\n\n"]);
  });
});

describe("GET /stream cleanup", () => {
  it("registers cleanup on both the request and the response close", () => {
    const stream = openStream();

    expect(stream.listeners("close")).toBe(2);
  });

  // A heartbeat that outlives the socket writes to a destroyed stream on
  // every tick, and a subscriber that outlives it leaks for the process
  // lifetime.
  it("unsubscribes and stops the heartbeat on close", () => {
    const stream = openStream();

    stream.fire("close");

    expect(stream.sse.unsubscribe).toHaveBeenCalled();
    const before = stream.writes.length;
    vi.advanceTimersByTime(100_000);
    expect(stream.writes).toHaveLength(before);
  });

  // Express fires close on both req and res for a single disconnect, so
  // the same cleanup runs twice — it must not throw the second time.
  it("survives the cleanup running once per close handler", () => {
    const stream = openStream();

    expect(() => stream.fire("close")).not.toThrow();

    expect(stream.sse.unsubscribe).toHaveBeenCalledTimes(2);
    const before = stream.writes.length;
    vi.advanceTimersByTime(100_000);
    expect(stream.writes).toHaveLength(before);
  });
});
