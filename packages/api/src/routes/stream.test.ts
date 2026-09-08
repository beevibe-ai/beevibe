/**
 * GET /api/stream — the browser SSE endpoint, driven over a real socket.
 *
 * supertest buffers until the response ends, and an SSE response never
 * ends, so these tests bind an ephemeral port and read the wire directly.
 * That is also the only way to check the parts that matter here: the
 * priming `data: {}` frame (the client's health probe never trips
 * without it), the per-person fanout filter, and the cleanup that
 * unsubscribes and clears the heartbeat when a browser goes away — a
 * leak there accumulates one live interval per reconnect.
 */
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCaller } from "@beevibe/core/auth";
import { SseManager } from "../sse/manager.js";
import { createStreamRouter } from "./stream.js";

const PERSON = "person_1";
const OTHER = "person_2";

const HUMAN: ResolvedCaller = {
  source: "human",
  agentId: "agent_a",
  hierarchyLevel: "ic",
  personId: PERSON,
};

const AGENT: ResolvedCaller = {
  source: "agent",
  agentId: "agent_a",
  hierarchyLevel: "ic",
};

function fakeAuth(caller: ResolvedCaller | undefined): RequestHandler {
  return (req, _res, next) => {
    req.caller = caller;
    next();
  };
}

interface Harness {
  port: number;
  sseManager: SseManager;
  close: () => Promise<void>;
}

const servers: http.Server[] = [];

async function startHarness(caller: ResolvedCaller | undefined): Promise<Harness> {
  const sseManager = new SseManager();
  const app = express();
  app.use("/api", createStreamRouter({ authMiddleware: fakeAuth(caller), sseManager }));
  const server = app.listen(0);
  servers.push(server);
  await once(server, "listening");
  return {
    port: (server.address() as AddressInfo).port,
    sseManager,
    close: async () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

interface Connection {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Everything received so far. */
  body: () => string;
  waitFor: (needle: string) => Promise<void>;
  disconnect: () => void;
}

function connect(port: number): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/api/stream" },
      (res) => {
        let buf = "";
        const waiters: Array<{ needle: string; resolve: () => void }> = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (buf.includes(waiters[i]!.needle)) {
              waiters[i]!.resolve();
              waiters.splice(i, 1);
            }
          }
        });
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: () => buf,
          waitFor: (needle) =>
            new Promise<void>((ok) => {
              if (buf.includes(needle)) return ok();
              waiters.push({ needle, resolve: ok });
            }),
          disconnect: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
  });
}

/** Let the event loop drain queued socket writes. */
const tick = () => new Promise((r) => setImmediate(r));

afterEach(() => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

describe("GET /api/stream auth", () => {
  it("rejects an agent caller with 403 and never subscribes it", async () => {
    const h = await startHarness(AGENT);

    const res = await fetch(`http://127.0.0.1:${h.port}/api/stream`);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "human_required" });
    expect(h.sseManager.size()).toBe(0);
  });

  it("rejects an unauthenticated request with 403", async () => {
    const h = await startHarness(undefined);

    const res = await fetch(`http://127.0.0.1:${h.port}/api/stream`);

    expect(res.status).toBe(403);
    expect(h.sseManager.size()).toBe(0);
  });
});

describe("GET /api/stream fanout", () => {
  it("opens an un-buffered event-stream and primes it with an empty data frame", async () => {
    const h = await startHarness(HUMAN);

    const conn = await connect(h.port);
    await conn.waitFor("data: {}");

    expect(conn.status).toBe(200);
    expect(conn.headers["content-type"]).toBe("text/event-stream");
    expect(conn.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(conn.headers["x-accel-buffering"]).toBe("no");
    // A comment line would not fire the browser's onmessage.
    expect(conn.body()).toBe("data: {}\n\n");

    conn.disconnect();
    await h.close();
  });

  it("writes events owned by the connected person as SSE data frames", async () => {
    const h = await startHarness(HUMAN);
    const conn = await connect(h.port);
    await conn.waitFor("data: {}");

    const event = { event: "task.updated", id: "task_1", data: { status: "done" } };
    h.sseManager.publish(event, new Set([PERSON]));
    await conn.waitFor("task.updated");

    expect(conn.body()).toBe(`data: {}\n\ndata: ${JSON.stringify(event)}\n\n`);

    conn.disconnect();
    await h.close();
  });

  it("does not write events owned by a different person", async () => {
    const h = await startHarness(HUMAN);
    const conn = await connect(h.port);
    await conn.waitFor("data: {}");

    h.sseManager.publish({ event: "task.updated", id: "task_9" }, new Set([OTHER]));
    await tick();

    expect(conn.body()).toBe("data: {}\n\n");

    conn.disconnect();
    await h.close();
  });

  it("registers exactly one subscriber per connection", async () => {
    const h = await startHarness(HUMAN);

    const a = await connect(h.port);
    await a.waitFor("data: {}");
    const b = await connect(h.port);
    await b.waitFor("data: {}");

    expect(h.sseManager.size()).toBe(2);

    a.disconnect();
    b.disconnect();
    await h.close();
  });
});

describe("GET /api/stream lifecycle", () => {
  it("unsubscribes when the browser disconnects", async () => {
    const h = await startHarness(HUMAN);
    const conn = await connect(h.port);
    await conn.waitFor("data: {}");
    expect(h.sseManager.size()).toBe(1);

    conn.disconnect();
    for (let i = 0; i < 50 && h.sseManager.size() > 0; i++) await tick();

    expect(h.sseManager.size()).toBe(0);
    await h.close();
  });

  it("sends a heartbeat comment every 25s and clears the timer on disconnect", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const h = await startHarness(HUMAN);
    const conn = await connect(h.port);
    await conn.waitFor("data: {}");

    await vi.advanceTimersByTimeAsync(25_000);
    await tick();
    expect(conn.body()).toBe("data: {}\n\n: heartbeat\n\n");

    await vi.advanceTimersByTimeAsync(25_000);
    await tick();
    expect(conn.body()).toBe("data: {}\n\n: heartbeat\n\n: heartbeat\n\n");

    conn.disconnect();
    for (let i = 0; i < 50 && h.sseManager.size() > 0; i++) await tick();
    expect(clearSpy).toHaveBeenCalled();

    // No further heartbeats once the connection is gone.
    const settled = conn.body();
    await vi.advanceTimersByTimeAsync(50_000);
    await tick();
    expect(conn.body()).toBe(settled);

    await h.close();
  });
});
