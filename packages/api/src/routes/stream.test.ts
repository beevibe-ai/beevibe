/**
 * `GET /api/stream` SSE handler — unit tests with a real `SseManager`
 * and a mock req/res pair (no socket).
 *
 * Supertest buffers a response until it ends, and this one never ends,
 * so the handler is driven directly through the router. That also makes
 * the two things worth pinning observable: the exact wire bytes the
 * browser's `EventSource` parses, and the cleanup on disconnect —
 * a leaked subscriber or interval here is a per-reload process leak.
 */
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SseManager } from "../sse/manager.js";
import { createStreamRouter } from "./stream.js";

const PERSON = "person_1";

class MockRes extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  flushHeaders = vi.fn();

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  // requireHuman's 403 path.
  status = vi.fn((code: number) => {
    this.statusCode = code;
    return this;
  });
  json = vi.fn((body: unknown) => {
    this.chunks.push(JSON.stringify(body));
    return this;
  });

  get body(): string {
    return this.chunks.join("");
  }
}

function drive(opts: { source?: "human" | "agent" } = {}) {
  const sseManager = new SseManager();
  const router = createStreamRouter({
    authMiddleware: (req, _res, next) => {
      req.caller =
        (opts.source ?? "human") === "human"
          ? { source: "human", agentId: "agent_1", hierarchyLevel: "team", personId: PERSON }
          : { source: "agent", agentId: "agent_1", hierarchyLevel: "team" };
      next();
    },
    sseManager,
  });

  const req = Object.assign(new EventEmitter(), {
    method: "GET",
    url: "/stream",
    headers: {},
  }) as unknown as Request;
  const res = new MockRes();

  const next = vi.fn();
  router(req, res as unknown as Response, next);
  return { req, res, sseManager, next };
}

describe("GET /stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("403s a non-human caller and never opens a stream", () => {
    const { res, sseManager } = drive({ source: "agent" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("human_required");
    // No stream headers, and no subscriber to fan out to.
    expect(res.headers).toEqual({});
    expect(res.flushHeaders).not.toHaveBeenCalled();
    sseManager.publish({ event: "task.updated", id: "t1" }, new Set([PERSON]));
    expect(res.chunks.some((c) => c.startsWith("data: "))).toBe(false);
  });

  it("sends the SSE headers proxies and browsers need", () => {
    const { res } = drive();
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Stops nginx from buffering the stream into uselessness.
      "X-Accel-Buffering": "no",
    });
    expect(res.flushHeaders).toHaveBeenCalled();
  });

  it("primes the connection with an empty data event", () => {
    const { res } = drive();
    // A comment line wouldn't fire the browser's onmessage, so the
    // client's health probe needs a real data line up front.
    expect(res.body).toBe("data: {}\n\n");
  });

  it("writes a published event as one SSE data frame", () => {
    const { res, sseManager } = drive();
    sseManager.publish({ event: "task.updated", id: "task_1" }, new Set([PERSON]));
    expect(res.chunks.at(-1)).toBe('data: {"event":"task.updated","id":"task_1"}\n\n');
  });

  it("does not write events owned by a different person", () => {
    const { res, sseManager } = drive();
    const before = res.chunks.length;
    sseManager.publish({ event: "task.updated", id: "task_1" }, new Set(["person_other"]));
    expect(res.chunks).toHaveLength(before);
  });

  it("emits a heartbeat comment every 25s", () => {
    const { res } = drive();
    vi.advanceTimersByTime(25_000);
    expect(res.chunks.at(-1)).toBe(": heartbeat\n\n");
    vi.advanceTimersByTime(25_000);
    expect(res.chunks.filter((c) => c === ": heartbeat\n\n")).toHaveLength(2);
  });

  it("stops the heartbeat and unsubscribes when the request closes", () => {
    const { req, res, sseManager } = drive();
    const beforeClose = res.chunks.length;

    req.emit("close");

    vi.advanceTimersByTime(100_000);
    sseManager.publish({ event: "task.updated", id: "task_1" }, new Set([PERSON]));
    // Neither the interval nor the subscriber survived the disconnect.
    expect(res.chunks).toHaveLength(beforeClose);
  });

  it("cleans up on a response-side close too", () => {
    const { res, sseManager } = drive();
    const beforeClose = res.chunks.length;

    res.emit("close");

    vi.advanceTimersByTime(100_000);
    sseManager.publish({ event: "task.updated", id: "task_1" }, new Set([PERSON]));
    expect(res.chunks).toHaveLength(beforeClose);
  });

  it("is idempotent when both close handlers fire", () => {
    const { req, res, sseManager } = drive();
    const beforeClose = res.chunks.length;

    // Node emits close on both halves for an aborted request.
    req.emit("close");
    res.emit("close");

    vi.advanceTimersByTime(100_000);
    sseManager.publish({ event: "task.updated", id: "task_1" }, new Set([PERSON]));
    expect(res.chunks).toHaveLength(beforeClose);
  });

  it("keeps two concurrent streams for the same person independent", () => {
    const sseManager = new SseManager();
    const mk = () => {
      const router = createStreamRouter({
        authMiddleware: (req, _res, next) => {
          req.caller = {
            source: "human",
            agentId: "agent_1",
            hierarchyLevel: "team",
            personId: PERSON,
          };
          next();
        },
        sseManager,
      });
      const req = Object.assign(new EventEmitter(), {
        method: "GET",
        url: "/stream",
        headers: {},
      }) as unknown as Request;
      const res = new MockRes();
      router(req, res as unknown as Response, vi.fn());
      return { req, res };
    };

    const a = mk();
    const b = mk();

    // Closing one tab must not deafen the other.
    a.req.emit("close");
    sseManager.publish({ event: "task.updated", id: "task_1" }, new Set([PERSON]));

    expect(a.res.chunks.at(-1)).toBe("data: {}\n\n");
    expect(b.res.chunks.at(-1)).toBe('data: {"event":"task.updated","id":"task_1"}\n\n');
  });
});
