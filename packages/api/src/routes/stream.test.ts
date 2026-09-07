/**
 * GET /stream (SSE) — driven over a real socket, since the whole route
 * is streaming side effects rather than a returned body.
 *
 * The two things that actually break here are the two tested hardest:
 * the response has to be unbuffered and un-cached end to end (a proxy
 * that buffers turns live updates into nothing), and disconnect has to
 * clear BOTH the heartbeat interval and the SseManager subscription —
 * leaking either one means a reconnecting browser accumulates writers
 * against a dead socket for the life of the process.
 *
 * Only the interval timers are faked; the socket I/O stays real, so a
 * 25s heartbeat is assertable without a 25s test.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SseManager, type BvEvent } from "../sse/manager.js";
import { createStreamRouter } from "./stream.js";

const PERSON = "person_1";

function stubAuth(source: "human" | "agent") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.caller =
      source === "human"
        ? { source: "human", agentId: "agent_a", hierarchyLevel: "team", personId: PERSON }
        : { source: "agent", agentId: "agent_a", hierarchyLevel: "ic" };
    next();
  };
}

interface Live {
  res: http.IncomingMessage;
  /** Everything received so far. */
  body: () => string;
  /** Resolves once the received body satisfies `pred`. */
  until: (pred: (body: string) => boolean) => Promise<void>;
  /**
   * Resolves when the server ends the response. Attached inside
   * `connect`, because a non-streaming reply (the 403) can complete
   * before the awaiting test body gets a turn to add its own listener.
   */
  ended: Promise<void>;
  close: () => void;
}

const servers: http.Server[] = [];

function start(sseManager: SseManager, source: "human" | "agent" = "human") {
  const app = express();
  app.use("/", createStreamRouter({ authMiddleware: stubAuth(source), sseManager }));
  const server = app.listen(0);
  servers.push(server);
  return server;
}

function connect(server: http.Server): Promise<Live> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve) => {
    // `agent: false` matters twice over: a fresh socket per request means
    // no pooled connection survives into the next test, and none of the
    // global agent's keep-alive timers land in the faked timer set.
    const req = http.get({ port, path: "/stream", agent: false }, (res) => {
      let body = "";
      const waiters: Array<{ pred: (b: string) => boolean; go: () => void }> = [];
      res.setEncoding("utf8");
      const ended = new Promise<void>((done) => res.on("end", () => done()));
      res.on("data", (chunk: string) => {
        body += chunk;
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.pred(body)) waiters.splice(i, 1)[0]!.go();
        }
      });
      resolve({
        res,
        body: () => body,
        until: (pred) =>
          new Promise<void>((go) => {
            if (pred(body)) return go();
            waiters.push({ pred, go });
          }),
        ended,
        close: () => req.destroy(),
      });
    });
  });
}

/** Give the server's own 'close' handlers a turn to run. */
function settle(): Promise<void> {
  return new Promise((r) => setImmediate(() => setImmediate(r)));
}

/**
 * Poll `pred` across macrotask turns. Used instead of a fixed number of
 * ticks because the server-side 'close' handler runs an indeterminate
 * few turns after the client destroys its socket. `setImmediate` is not
 * in the faked timer set, so this works under fake timers too.
 */
async function waitFor(pred: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (pred()) return;
    await settle();
  }
  throw new Error("condition not met before the turn budget ran out");
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("GET /stream", () => {
  it("opens an unbuffered event-stream and sends a priming data event", async () => {
    const live = await connect(start(new SseManager()));
    await live.until((b) => b.includes("data: {}"));

    expect(live.res.statusCode).toBe(200);
    expect(live.res.headers["content-type"]).toBe("text/event-stream");
    // These three are what keep nginx / cloudflared from buffering the
    // stream into a single delivery at the end.
    expect(live.res.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(live.res.headers["x-accel-buffering"]).toBe("no");
    // A comment line would not fire the browser's onmessage, so the
    // primer has to be a data line.
    expect(live.body()).toBe("data: {}\n\n");

    live.close();
  });

  it("writes each event the manager fans out to this person", async () => {
    const sseManager = new SseManager();
    const live = await connect(start(sseManager));
    await live.until((b) => b.includes("data: {}"));

    const event: BvEvent = { event: "task.updated", id: "task_1" };
    sseManager.publish(event, new Set([PERSON]));
    await live.until((b) => b.includes("task.updated"));

    expect(live.body()).toBe(`data: {}\n\ndata: ${JSON.stringify(event)}\n\n`);

    live.close();
  });

  it("does not write events owned by a different person", async () => {
    const sseManager = new SseManager();
    const live = await connect(start(sseManager));
    await live.until((b) => b.includes("data: {}"));

    sseManager.publish({ event: "task.updated", id: "task_1" }, new Set(["person_other"]));
    await settle();

    expect(live.body()).toBe("data: {}\n\n");

    live.close();
  });

  it("emits a heartbeat comment every 25s", async () => {
    // Fake only the interval timers; the socket keeps real I/O.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const live = await connect(start(new SseManager()));
    await live.until((b) => b.includes("data: {}"));

    vi.advanceTimersByTime(25_000);
    await live.until((b) => b.includes(": heartbeat"));
    vi.advanceTimersByTime(25_000);
    await live.until((b) => b.split(": heartbeat").length === 3);

    live.close();
  });

  it("unsubscribes and stops the heartbeat when the client disconnects", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const sseManager = new SseManager();
    const live = await connect(start(sseManager));
    await live.until((b) => b.includes("data: {}"));
    expect(sseManager.size()).toBe(1);

    live.close();
    await waitFor(() => sseManager.size() === 0);

    // The subscription is gone, so a later publish has no one to write
    // to a socket that no longer exists.
    expect(sseManager.size()).toBe(0);
    // And the interval is cleared, so nothing is left firing forever.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a non-human caller before opening a stream", async () => {
    const sseManager = new SseManager();
    const live = await connect(start(sseManager, "agent"));
    await live.ended;

    expect(live.res.statusCode).toBe(403);
    expect(JSON.parse(live.body()).error).toBe("human_required");
    expect(sseManager.size()).toBe(0);
  });
});
