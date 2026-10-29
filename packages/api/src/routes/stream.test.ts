/**
 * GET /stream — SSE live-update route. Unit tests with a real
 * SseManager and a fake auth middleware (no DB).
 *
 * This handler is all side effects on a long-lived socket, so the tests
 * drive it through the response object rather than a request/response
 * round-trip: supertest would hang on a stream that never ends. What
 * matters is the handshake (the headers that keep proxies from
 * buffering, plus the priming `data: {}` the browser needs to fire
 * `onmessage`), per-person fanout, the 25s heartbeat, and that BOTH
 * close paths tear down the interval and the subscription — a leaked
 * interval here writes to a dead socket forever.
 */
import { EventEmitter } from "node:events";
import type { RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SseManager } from "../sse/manager.js";
import { createStreamRouter } from "./stream.js";

const PERSON = "person_1";
const OTHER = "person_2";

interface FakeRes {
  writeHead: ReturnType<typeof vi.fn>;
  flushHeaders?: () => void;
  write: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  on: (ev: string, cb: () => void) => void;
  emitClose: () => void;
  lines: string[];
  statusCode?: number;
  body?: unknown;
}

function fakeRes(opts: { withFlush?: boolean } = {}): FakeRes {
  const emitter = new EventEmitter();
  const lines: string[] = [];
  const res: FakeRes = {
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      lines.push(chunk);
      return true;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    on: (ev, cb) => {
      emitter.on(ev, cb);
    },
    emitClose: () => emitter.emit("close"),
    lines,
  };
  if (opts.withFlush !== false) res.flushHeaders = vi.fn();
  return res;
}

/**
 * Pull the `GET /stream` handler out of the router and call it directly
 * with a fake req/res pair, bypassing express's socket handling.
 */
function streamHandler(authMiddleware: RequestHandler, sseManager: SseManager) {
  const router = createStreamRouter({ authMiddleware, sseManager });
  const layer = router.stack.find(
    (l: { route?: { path: string } }) => l.route?.path === "/stream",
  ) as { route: { stack: Array<{ handle: RequestHandler }> } } | undefined;
  const handle = layer?.route.stack[0]?.handle;
  if (!handle) throw new Error("GET /stream not registered on the router");
  return handle;
}

const allowHuman: RequestHandler = (_req, _res, next) => next();

function humanReq(personId = PERSON) {
  const req = new EventEmitter() as EventEmitter & {
    caller: { source: string; personId: string };
    emitClose: () => void;
  };
  req.caller = { source: "human", personId };
  req.emitClose = () => req.emit("close");
  return req;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createStreamRouter", () => {
  it("registers GET /stream behind the supplied auth middleware", () => {
    const authMiddleware = vi.fn((_req, _res, next) => next()) as unknown as RequestHandler;
    const router = createStreamRouter({ authMiddleware, sseManager: new SseManager() });

    const paths = router.stack
      .map((l: { route?: { path: string } }) => l.route?.path)
      .filter(Boolean);
    expect(paths).toContain("/stream");
    // The middleware is mounted router-wide (router.use), not per-route.
    expect(router.stack.some((l: { handle?: unknown }) => l.handle === authMiddleware)).toBe(true);
  });
});

describe("GET /stream handshake", () => {
  it("sends the no-buffering SSE headers and flushes them", () => {
    const res = fakeRes();
    streamHandler(allowHuman, new SseManager())(humanReq() as never, res as never, vi.fn());

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  it("tolerates a response object without flushHeaders", () => {
    const res = fakeRes({ withFlush: false });
    expect(() =>
      streamHandler(allowHuman, new SseManager())(humanReq() as never, res as never, vi.fn()),
    ).not.toThrow();
    expect(res.lines[0]).toBe("data: {}\n\n");
  });

  it("primes the stream with a data line so the browser's onmessage fires", () => {
    const res = fakeRes();
    streamHandler(allowHuman, new SseManager())(humanReq() as never, res as never, vi.fn());

    // A comment line would not trip onmessage; it has to be `data:`, and
    // the empty object parses to {} which the client filter drops.
    expect(res.lines).toEqual(["data: {}\n\n"]);
    expect(JSON.parse(res.lines[0]!.slice("data: ".length))).toEqual({});
  });

  it("rejects a non-human caller with 403 and opens no stream", () => {
    const res = fakeRes();
    const req = new EventEmitter() as EventEmitter & { caller: { source: string } };
    req.caller = { source: "agent" };

    streamHandler(allowHuman, new SseManager())(req as never, res as never, vi.fn());

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ error: "human_required" });
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
  });
});

describe("GET /stream fanout", () => {
  it("writes events owned by the subscriber's person", () => {
    const manager = new SseManager();
    const res = fakeRes();
    streamHandler(allowHuman, manager)(humanReq() as never, res as never, vi.fn());

    manager.publish({ event: "task.updated", id: "tsk_1" }, new Set([PERSON]));

    expect(res.lines).toEqual([
      "data: {}\n\n",
      `data: ${JSON.stringify({ event: "task.updated", id: "tsk_1" })}\n\n`,
    ]);
  });

  it("serializes an event's inline data payload", () => {
    const manager = new SseManager();
    const res = fakeRes();
    streamHandler(allowHuman, manager)(humanReq() as never, res as never, vi.fn());

    const event = {
      event: "session.step",
      id: "sess_1",
      data: { kind: "tool_call", tool_name: "Bash" },
    };
    manager.publish(event, new Set([PERSON]));

    expect(JSON.parse(res.lines[1]!.slice("data: ".length))).toEqual(event);
  });

  it("does not write events owned by someone else", () => {
    const manager = new SseManager();
    const res = fakeRes();
    streamHandler(allowHuman, manager)(humanReq() as never, res as never, vi.fn());

    manager.publish({ event: "task.updated", id: "tsk_1" }, new Set([OTHER]));

    expect(res.lines).toEqual(["data: {}\n\n"]);
  });

  it("gives each connected person their own stream", () => {
    const manager = new SseManager();
    const mine = fakeRes();
    const theirs = fakeRes();
    const handler = streamHandler(allowHuman, manager);
    handler(humanReq(PERSON) as never, mine as never, vi.fn());
    handler(humanReq(OTHER) as never, theirs as never, vi.fn());

    manager.publish({ event: "task.updated", id: "tsk_1" }, new Set([OTHER]));

    expect(mine.lines).toHaveLength(1);
    expect(theirs.lines).toHaveLength(2);
  });
});

describe("GET /stream heartbeat and teardown", () => {
  it("writes a comment heartbeat every 25s", () => {
    const res = fakeRes();
    streamHandler(allowHuman, new SseManager())(humanReq() as never, res as never, vi.fn());

    vi.advanceTimersByTime(24_999);
    expect(res.lines).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(res.lines[1]).toBe(": heartbeat\n\n");

    vi.advanceTimersByTime(50_000);
    expect(res.lines.filter((l) => l === ": heartbeat\n\n")).toHaveLength(3);
  });

  it("stops the heartbeat and unsubscribes when the request closes", () => {
    const manager = new SseManager();
    const res = fakeRes();
    const req = humanReq();
    streamHandler(allowHuman, manager)(req as never, res as never, vi.fn());

    req.emitClose();
    vi.advanceTimersByTime(100_000);
    manager.publish({ event: "task.updated", id: "tsk_1" }, new Set([PERSON]));

    expect(res.lines).toEqual(["data: {}\n\n"]);
  });

  it("stops the heartbeat and unsubscribes when the response closes", () => {
    const manager = new SseManager();
    const res = fakeRes();
    streamHandler(allowHuman, manager)(humanReq() as never, res as never, vi.fn());

    res.emitClose();
    vi.advanceTimersByTime(100_000);
    manager.publish({ event: "task.updated", id: "tsk_1" }, new Set([PERSON]));

    expect(res.lines).toEqual(["data: {}\n\n"]);
  });

  it("is idempotent when both close events fire", () => {
    const manager = new SseManager();
    const res = fakeRes();
    const req = humanReq();
    streamHandler(allowHuman, manager)(req as never, res as never, vi.fn());

    req.emitClose();
    res.emitClose();
    vi.advanceTimersByTime(100_000);
    manager.publish({ event: "task.updated", id: "tsk_1" }, new Set([PERSON]));

    expect(res.lines).toEqual(["data: {}\n\n"]);
  });
});
