/**
 * Tests for the SSE router (`GET /api/stream`).
 *
 * The route is small but every line of it is a browser-visible contract:
 * the header set that keeps proxies from buffering, the priming `data: {}`
 * frame the client's health probe waits on, the heartbeat that stops
 * idle-timeouts, and the unsubscribe that has to run on disconnect or the
 * SseManager leaks a subscriber per dropped connection.
 *
 * Driven against a real Express app with a fake auth middleware and the
 * real SseManager — no DB. `supertest` buffers the whole response, which
 * never arrives on an open SSE stream, so these tests listen on an
 * ephemeral port and read frames off the socket as they land.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import express, { type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { get as httpGet, type IncomingMessage, type Server } from "node:http";
import { createStreamRouter } from "./stream.js";
import { SseManager } from "../sse/manager.js";

const PERSON = "per_alice";

function callerAs(caller: unknown): RequestHandler {
  return (req, _res, next) => {
    if (caller !== null) (req as { caller?: unknown }).caller = caller;
    next();
  };
}

const humanCaller = { source: "human", personId: PERSON };
const agentCaller = { source: "agent", personId: PERSON, agentId: "agt_1" };

const openSockets: Array<{ close: () => void }> = [];
const servers: Server[] = [];

afterEach(async () => {
  while (openSockets.length) openSockets.pop()?.close();
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

async function listen(caller: unknown = humanCaller): Promise<{
  url: string;
  sseManager: SseManager;
}> {
  const sseManager = new SseManager();
  const app = express();
  app.use("/api", createStreamRouter({ authMiddleware: callerAs(caller), sseManager }));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/stream`, sseManager };
}

/**
 * Open the stream and expose an async frame reader over the raw body.
 * Uses `node:http` rather than `fetch` so `close()` destroys the socket
 * immediately — undici holds an aborted connection open for seconds,
 * which would make the disconnect assertion below slow and flaky.
 */
async function openStream(url: string) {
  const chunks: string[] = [];
  let waiter: ((chunk: string) => void) | undefined;

  const res = await new Promise<IncomingMessage>((resolve) => {
    httpGet(url, (r) => {
      r.setEncoding("utf8");
      r.on("data", (chunk: string) => {
        if (waiter) {
          const w = waiter;
          waiter = undefined;
          w(chunk);
        } else {
          chunks.push(chunk);
        }
      });
      resolve(r);
    });
  });

  const handle = {
    res,
    /**
     * Next decoded chunk off the wire. Rejects rather than hanging if the
     * route stops writing — a frame that never arrives should fail the
     * test in a second, not sit out the suite timeout.
     */
    chunk(): Promise<string> {
      const buffered = chunks.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = undefined;
          reject(new Error("timed out waiting for the next SSE frame"));
        }, 2_000);
        waiter = (chunk) => {
          clearTimeout(timer);
          resolve(chunk);
        };
      });
    },
    close() {
      res.destroy();
    },
  };
  openSockets.push(handle);
  return handle;
}

describe("GET /api/stream", () => {
  it("rejects a non-human caller with 403 and registers no subscriber", async () => {
    const { url, sseManager } = await listen(agentCaller);

    const res = await fetch(url);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "human_required" });
    expect(sseManager.size()).toBe(0);
  });

  it("sets the no-buffering SSE headers and primes the client with an empty data frame", async () => {
    const { url } = await listen();
    const stream = await openStream(url);

    expect(stream.res.statusCode).toBe(200);
    expect(stream.res.headers["content-type"]).toBe("text/event-stream");
    expect(stream.res.headers["cache-control"]).toBe("no-cache, no-transform");
    // Set so nginx/cloudflared don't sit on the frames.
    expect(stream.res.headers["x-accel-buffering"]).toBe("no");

    // An SSE comment wouldn't fire onmessage in the browser; the priming
    // frame has to be a data line for the client health probe to trip.
    expect(await stream.chunk()).toBe("data: {}\n\n");
  });

  it("forwards events published for the subscriber's person", async () => {
    const { url, sseManager } = await listen();
    const stream = await openStream(url);
    await stream.chunk(); // priming frame
    expect(sseManager.size()).toBe(1);

    const event = { event: "task.updated", id: "tsk_1" };
    sseManager.publish(event, new Set([PERSON]));

    expect(await stream.chunk()).toBe(`data: ${JSON.stringify(event)}\n\n`);
  });

  it("does not forward events owned by a different person", async () => {
    const { url, sseManager } = await listen();
    const stream = await openStream(url);
    await stream.chunk();

    sseManager.publish({ event: "task.updated", id: "tsk_other" }, new Set(["per_bob"]));
    sseManager.publish({ event: "task.updated", id: "tsk_mine" }, new Set([PERSON]));

    // The first frame off the wire is the one addressed to us — the
    // other person's event was filtered, not queued behind it.
    expect(await stream.chunk()).toContain("tsk_mine");
  });

  it("writes a heartbeat comment on the keep-alive interval", async () => {
    // Fake only setInterval: the socket I/O below has to stay real.
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const { url } = await listen();
    const stream = await openStream(url);
    await stream.chunk();

    vi.advanceTimersByTime(25_000);

    expect(await stream.chunk()).toBe(": heartbeat\n\n");
  });

  it("unsubscribes when the client disconnects", async () => {
    const { url, sseManager } = await listen();
    const stream = await openStream(url);
    await stream.chunk();
    expect(sseManager.size()).toBe(1);

    stream.close();

    // The close handler runs on the server's event loop, not ours.
    await vi.waitFor(() => expect(sseManager.size()).toBe(0));
  });
});
