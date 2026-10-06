/**
 * `GET /api/stream` — the SSE live-update route, unit-tested with fakes.
 *
 * Everything here exists because of a browser-side failure mode:
 *
 *   - the priming `data: {}` line is what trips the client's health
 *     probe (SSE comments don't fire `onmessage`), so dropping it
 *     silently leaves the UI "connecting" forever;
 *   - the 25s heartbeat is what keeps nginx/cloudflared from idling the
 *     connection out;
 *   - the close handlers are what stop a reload from leaking an
 *     interval and an SseManager subscriber per tab.
 *
 * The route never ends its response, so supertest can't drive it — the
 * router is invoked against mock req/res objects instead, which also
 * makes the heartbeat deterministic under fake timers.
 */
import { EventEmitter } from "node:events";
import type { RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BvEvent, SseManager } from "../sse/manager.js";
import { createStreamRouter } from "./stream.js";

type MockReq = EventEmitter & Record<string, unknown>;
type MockRes = EventEmitter & Record<string, unknown>;

function mockPair() {
  const req = new EventEmitter() as MockReq;
  req.url = "/stream";
  req.method = "GET";
  req.headers = {};

  const res = new EventEmitter() as MockRes;
  res.writeHead = vi.fn(() => res);
  res.flushHeaders = vi.fn();
  res.write = vi.fn(() => true);
  res.end = vi.fn(() => res);
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return { req, res };
}

/** Everything the handler wrote, as the raw SSE wire text. */
function written(res: MockRes): string {
  return (res.write as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => String(c[0]))
    .join("");
}

interface Harness {
  deps: Parameters<typeof createStreamRouter>[0];
  /** Fires the subscriber the handler registered, as SseManager would. */
  publish: (event: BvEvent) => void;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
}

const HUMAN = { source: "human", personId: "pers_abc" };

/** `caller: null` stands for a request the auth middleware left bare. */
function harness(caller: Record<string, unknown> | null = HUMAN): Harness {
  let sink: ((event: BvEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((_personId: string, cb: (event: BvEvent) => void) => {
    sink = cb;
    return unsubscribe;
  });

  const authMiddleware: RequestHandler = (req, _res, next) => {
    if (caller) (req as unknown as Record<string, unknown>).caller = caller;
    next();
  };

  return {
    deps: { authMiddleware, sseManager: { subscribe } as unknown as SseManager },
    publish: (event) => sink?.(event),
    subscribe,
    unsubscribe,
  };
}

function connect(h: Harness) {
  const { req, res } = mockPair();
  const router = createStreamRouter(h.deps);
  (router as unknown as (r: unknown, s: unknown, n: () => void) => void)(
    req,
    res,
    () => {},
  );
  return { req, res };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /stream — handshake", () => {
  it("writes the SSE headers proxies and browsers need", () => {
    const h = harness();
    const { res } = connect(h);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  it("primes the stream with a data line so the client's onmessage fires", () => {
    const h = harness();
    const { res } = connect(h);

    // A comment line would not trip the browser health probe; the empty
    // object parses cleanly and the client filter drops it.
    expect(written(res)).toBe("data: {}\n\n");
  });

  it("subscribes the caller's personId, not the agent id", () => {
    const h = harness({ source: "human", personId: "pers_xyz" });
    connect(h);

    expect(h.subscribe).toHaveBeenCalledTimes(1);
    expect(h.subscribe.mock.calls[0]?.[0]).toBe("pers_xyz");
  });

  it("tolerates a response object with no flushHeaders", () => {
    const h = harness();
    const { req, res } = mockPair();
    delete res.flushHeaders;
    const router = createStreamRouter(h.deps);

    expect(() =>
      (router as unknown as (r: unknown, s: unknown, n: () => void) => void)(
        req,
        res,
        () => {},
      ),
    ).not.toThrow();
    expect(written(res)).toBe("data: {}\n\n");
  });
});

describe("GET /stream — auth gating", () => {
  it.each([
    ["an agent caller", { source: "agent", agentId: "agent_a" }],
    ["a daemon caller", { source: "daemon", daemonId: "daem_a" }],
    ["no caller at all", null],
  ])("rejects %s with 403 and never subscribes", (_label, caller) => {
    const h = harness(caller as Record<string, unknown> | null);
    const { res } = connect(h);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "human_required",
      message: "this endpoint requires a bv_u_ token",
    });
    expect(h.subscribe).not.toHaveBeenCalled();
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});

describe("GET /stream — fanout", () => {
  it("serializes each published event as one SSE data frame", () => {
    const h = harness();
    const { res } = connect(h);

    h.publish({ event: "task.updated", id: "task_1" });
    h.publish({ event: "session.step", id: "sess_1", data: { kind: "agent" } });

    expect(written(res)).toBe(
      "data: {}\n\n" +
        'data: {"event":"task.updated","id":"task_1"}\n\n' +
        'data: {"event":"session.step","id":"sess_1","data":{"kind":"agent"}}\n\n',
    );
  });

  it("sends a heartbeat comment every 25s", () => {
    const h = harness();
    const { res } = connect(h);

    vi.advanceTimersByTime(24_999);
    expect(written(res)).toBe("data: {}\n\n");

    vi.advanceTimersByTime(1);
    expect(written(res)).toBe("data: {}\n\n: heartbeat\n\n");

    vi.advanceTimersByTime(50_000);
    expect(written(res)).toBe(
      "data: {}\n\n: heartbeat\n\n: heartbeat\n\n: heartbeat\n\n",
    );
  });
});

describe("GET /stream — cleanup", () => {
  it("clears the heartbeat and unsubscribes when the request closes", () => {
    const h = harness();
    const { req, res } = connect(h);

    req.emit("close");

    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100_000);
    expect(written(res)).toBe("data: {}\n\n");
  });

  it("cleans up on a response close too (proxy drops the socket)", () => {
    const h = harness();
    const { res } = connect(h);

    res.emit("close");

    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100_000);
    expect(written(res)).toBe("data: {}\n\n");
  });

  it("is idempotent when both close events fire", () => {
    const h = harness();
    const { req, res } = connect(h);

    req.emit("close");
    res.emit("close");

    expect(h.unsubscribe).toHaveBeenCalledTimes(2);
    // Still no extra writes — the interval is gone either way.
    vi.advanceTimersByTime(100_000);
    expect(written(res)).toBe("data: {}\n\n");
  });
});
