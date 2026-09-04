/**
 * GET /api/stream — the browser SSE endpoint.
 *
 * The response never ends, so this drives the router with a fake
 * req/res pair rather than supertest: the handler is synchronous, so
 * everything it wires up (headers, priming event, subscription,
 * heartbeat, teardown) is observable the moment the call returns.
 *
 * A real SseManager is used — it's a plain in-memory registry, and the
 * point of most of these assertions is that a published event actually
 * reaches the socket.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestHandler } from "express";
import { SseManager } from "../sse/manager.js";
import { createStreamRouter } from "./stream.js";

const PERSON = "per_alice";
const OTHER = "per_bob";

const humanCaller = { source: "human", personId: PERSON };
const agentCaller = { source: "agent", personId: PERSON, agentId: "agt_1" };

function callerAs(caller: unknown): RequestHandler {
  return (req, _res, next) => {
    if (caller !== null) (req as { caller?: unknown }).caller = caller;
    next();
  };
}

interface FakeRes extends EventEmitter {
  writeHead: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  flushHeaders?: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  statusCode?: number;
  body?: unknown;
}

function makeRes(opts: { flushHeaders?: boolean } = {}): FakeRes {
  const res = new EventEmitter() as FakeRes;
  res.writeHead = vi.fn(() => res);
  res.write = vi.fn(() => true);
  if (opts.flushHeaders !== false) res.flushHeaders = vi.fn();
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

interface Harness {
  req: EventEmitter & { caller?: unknown };
  res: FakeRes;
  manager: SseManager;
  /** Data lines the handler wrote, minus the SSE framing. */
  dataLines: () => string[];
}

function open(
  opts: { caller?: unknown; manager?: SseManager; flushHeaders?: boolean } = {},
): Harness {
  const manager = opts.manager ?? new SseManager();
  const router = createStreamRouter({
    authMiddleware: callerAs("caller" in opts ? opts.caller : humanCaller),
    sseManager: manager,
  });

  const req = new EventEmitter() as EventEmitter & {
    url: string;
    method: string;
    headers: Record<string, string>;
  };
  req.url = "/stream";
  req.method = "GET";
  req.headers = {};
  const res = makeRes({ flushHeaders: opts.flushHeaders });

  // Express routers are request handlers; the /stream handler runs
  // synchronously and never calls next().
  (router as unknown as (req: unknown, res: unknown, next: () => void) => void)(
    req,
    res,
    () => undefined,
  );

  return {
    req,
    res,
    manager,
    dataLines: () =>
      res.write.mock.calls
        .map((c) => String(c[0]))
        .filter((chunk) => chunk.startsWith("data: "))
        .map((chunk) => chunk.slice("data: ".length).trimEnd()),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /stream — auth", () => {
  it.each([
    ["an agent caller", agentCaller],
    ["no caller at all", null],
  ])("rejects %s with 403 and never opens the stream", (_label, caller) => {
    const { res, manager } = open({ caller });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({
      error: "human_required",
      message: "this endpoint requires a bv_u_ token",
    });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(manager.size()).toBe(0);
  });
});

describe("GET /stream — connection setup", () => {
  it("writes the SSE headers proxies need to leave the stream alone", () => {
    const { res } = open();
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  it("survives a response object with no flushHeaders", () => {
    const { res } = open({ flushHeaders: false });
    expect(res.writeHead).toHaveBeenCalled();
    expect(res.write).toHaveBeenCalledWith("data: {}\n\n");
  });

  it("primes the stream with an empty data event", () => {
    // SSE comments don't fire onmessage in the browser, so the client's
    // health probe needs a real data line before the first event.
    const { res, dataLines } = open();
    expect(res.write.mock.calls[0]![0]).toBe("data: {}\n\n");
    expect(JSON.parse(dataLines()[0]!)).toEqual({});
  });

  it("registers exactly one subscriber", () => {
    const { manager } = open();
    expect(manager.size()).toBe(1);
  });
});

describe("GET /stream — fanout", () => {
  it("writes an event published to the caller's person id", () => {
    const { manager, dataLines } = open();
    const event = { event: "task.updated", id: "tsk_1" };
    manager.publish(event, new Set([PERSON]));
    expect(dataLines()).toEqual(["{}", JSON.stringify(event)]);
  });

  it("passes an inline payload through untouched", () => {
    const { manager, dataLines } = open();
    const event = {
      event: "session.step",
      id: "sess_1",
      data: { kind: "tool_use", tool_name: "Bash" },
    };
    manager.publish(event, new Set([PERSON]));
    expect(JSON.parse(dataLines()[1]!)).toEqual(event);
  });

  it("does not write an event owned by somebody else", () => {
    const { manager, dataLines } = open();
    manager.publish({ event: "task.updated", id: "tsk_1" }, new Set([OTHER]));
    expect(dataLines()).toEqual(["{}"]);
  });

  it("keeps two subscribers on one manager independent", () => {
    const manager = new SseManager();
    const alice = open({ manager });
    const bob = open({ manager, caller: { source: "human", personId: OTHER } });
    expect(manager.size()).toBe(2);

    manager.publish({ event: "task.updated", id: "tsk_1" }, new Set([OTHER]));
    expect(alice.dataLines()).toEqual(["{}"]);
    expect(bob.dataLines()).toHaveLength(2);
  });
});

describe("GET /stream — heartbeat", () => {
  it("writes a comment line every 25s", () => {
    const { res } = open();
    const heartbeats = () =>
      res.write.mock.calls.filter((c) => c[0] === ": heartbeat\n\n").length;

    expect(heartbeats()).toBe(0);
    vi.advanceTimersByTime(24_999);
    expect(heartbeats()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(heartbeats()).toBe(1);
    vi.advanceTimersByTime(50_000);
    expect(heartbeats()).toBe(3);
  });
});

describe("GET /stream — teardown", () => {
  it.each([["req"], ["res"]])(
    "unsubscribes and stops the heartbeat when %s closes",
    (which) => {
      const { req, res, manager } = open();
      const emitter = which === "req" ? req : res;
      emitter.emit("close");

      expect(manager.size()).toBe(0);
      const before = res.write.mock.calls.length;
      vi.advanceTimersByTime(60_000);
      expect(res.write.mock.calls).toHaveLength(before);
    },
  );

  it("stops writing events after close", () => {
    const { req, manager, dataLines } = open();
    req.emit("close");
    manager.publish({ event: "task.updated", id: "tsk_1" }, new Set([PERSON]));
    expect(dataLines()).toEqual(["{}"]);
  });

  it("is idempotent when both req and res close", () => {
    const { req, res, manager } = open();
    req.emit("close");
    res.emit("close");
    expect(manager.size()).toBe(0);
  });
});
