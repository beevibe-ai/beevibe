/**
 * `GET /stream` — the SSE channel the web client hangs React Query
 * invalidation off. Driven over a real socket rather than supertest,
 * because the handler never ends the response: what matters is the
 * headers, the priming event, per-person fan-out, the heartbeat, and
 * that a disconnect actually unsubscribes (a leak here grows an
 * unbounded subscriber set on the long-lived api process).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { SseManager } from "../sse/manager.js";
import { createStreamRouter } from "./stream.js";

const PERSON = "person_1";
const OTHER = "person_2";

function stubAuth(source: "human" | "agent") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.caller =
      source === "human"
        ? { source: "human", agentId: "agent_a", hierarchyLevel: "team", personId: PERSON }
        : { source: "agent", agentId: "agent_a", hierarchyLevel: "ic" };
    next();
  };
}

const servers: Server[] = [];

/** Bind on port 0 so parallel runs never collide. */
async function serve(
  sseManager: SseManager,
  source: "human" | "agent" = "human",
): Promise<number> {
  const app = express();
  app.use("/", createStreamRouter({ authMiddleware: stubAuth(source), sseManager }));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return (server.address() as AddressInfo).port;
}

interface OpenStream {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Everything received so far. */
  text(): string;
  /** Resolves once `text()` satisfies `pred`. */
  waitFor(pred: (text: string) => boolean): Promise<void>;
  close(): void;
}

function open(port: number): Promise<OpenStream> {
  return new Promise((resolve, reject) => {
    const req = get({ port, path: "/stream" }, (res) => {
      let buf = "";
      const waiters: Array<{ pred: (t: string) => boolean; resolve: () => void }> = [];
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        for (const w of waiters.splice(0)) {
          if (w.pred(buf)) w.resolve();
          else waiters.push(w);
        }
      });
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => buf,
        waitFor: (pred) =>
          pred(buf)
            ? Promise.resolve()
            : new Promise<void>((r) => waiters.push({ pred, resolve: r })),
        close: () => req.destroy(),
      });
    });
    req.on("error", reject);
  });
}

/** One parsed `data:` line per event, dropping SSE comments. */
function dataLines(text: string): unknown[] {
  return text
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)));
}

/**
 * Records the handler's `setInterval` registrations while still arming
 * the real timer, so tests can fire the heartbeat by hand without
 * replacing the timer globals — faking those breaks the socket-close
 * cleanup that runs after a test ends.
 */
function recordIntervals(): Array<{ fn: () => void; ms: number }> {
  const calls: Array<{ fn: () => void; ms: number }> = [];
  const real = global.setInterval;
  vi.spyOn(global, "setInterval").mockImplementation(((
    fn: () => void,
    ms: number,
    ...rest: unknown[]
  ) => {
    calls.push({ fn, ms });
    return real(fn, ms, ...(rest as []));
  }) as unknown as typeof global.setInterval);
  return calls;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});

describe("GET /stream", () => {
  it("403s a non-human caller and never subscribes", async () => {
    const sse = new SseManager();
    const subscribe = vi.spyOn(sse, "subscribe");
    const port = await serve(sse, "agent");

    const stream = await open(port);
    expect(stream.status).toBe(403);
    expect(subscribe).not.toHaveBeenCalled();
    stream.close();
  });

  it("opens with the SSE headers that keep proxies from buffering", async () => {
    const port = await serve(new SseManager());

    const stream = await open(port);
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toBe("text/event-stream");
    expect(stream.headers["cache-control"]).toBe("no-cache, no-transform");
    expect(stream.headers["connection"]).toBe("keep-alive");
    expect(stream.headers["x-accel-buffering"]).toBe("no");
    stream.close();
  });

  it("primes the channel with an empty data event so onmessage fires", async () => {
    const port = await serve(new SseManager());

    const stream = await open(port);
    await stream.waitFor((t) => t.includes("\n\n"));
    // A comment line wouldn't trip the client's health probe; a data
    // line that parses to {} does, and the client filter drops it.
    expect(stream.text()).toBe("data: {}\n\n");
    expect(dataLines(stream.text())).toEqual([{}]);
    stream.close();
  });

  it("forwards an event published for this person", async () => {
    const sse = new SseManager();
    const port = await serve(sse);
    const stream = await open(port);
    await stream.waitFor((t) => t.includes("data: {}"));

    sse.publish({ event: "task.updated", id: "task_1" }, new Set([PERSON]));
    await stream.waitFor((t) => t.includes("task.updated"));

    expect(dataLines(stream.text())).toEqual([{}, { event: "task.updated", id: "task_1" }]);
    stream.close();
  });

  it("serializes an inline data payload intact", async () => {
    const sse = new SseManager();
    const port = await serve(sse);
    const stream = await open(port);
    await stream.waitFor((t) => t.includes("data: {}"));

    const event = {
      event: "session.step",
      id: "sess_1",
      data: { kind: "tool_call", tool_name: "Bash", content: "ls -la" },
    };
    sse.publish(event, new Set([PERSON]));
    await stream.waitFor((t) => t.includes("session.step"));

    expect(dataLines(stream.text())[1]).toEqual(event);
    stream.close();
  });

  it("does not leak an event owned by someone else", async () => {
    const sse = new SseManager();
    const port = await serve(sse);
    const stream = await open(port);
    await stream.waitFor((t) => t.includes("data: {}"));

    sse.publish({ event: "task.updated", id: "task_other" }, new Set([OTHER]));
    // Then one we should see, to prove the first had time to arrive.
    sse.publish({ event: "task.updated", id: "task_mine" }, new Set([PERSON]));
    await stream.waitFor((t) => t.includes("task_mine"));

    expect(stream.text()).not.toContain("task_other");
    stream.close();
  });

  it("arms a 25s heartbeat that writes a comment, not an event", async () => {
    const intervals = recordIntervals();
    const sse = new SseManager();
    const port = await serve(sse);
    const stream = await open(port);
    await stream.waitFor((t) => t.includes("data: {}"));

    const heartbeat = intervals.find((c) => c.ms === 25_000);
    expect(heartbeat).toBeDefined();

    // Fire it by hand rather than waiting out the real 25s.
    heartbeat!.fn();
    await stream.waitFor((t) => t.includes(": heartbeat"));
    expect(stream.text()).toContain(": heartbeat\n\n");

    heartbeat!.fn();
    await stream.waitFor((t) => t.split(": heartbeat").length === 3);
    // Comments must not parse as events on the client.
    expect(dataLines(stream.text())).toEqual([{}]);
    stream.close();
  });

  it("unsubscribes and clears the heartbeat when the client disconnects", async () => {
    const intervals = recordIntervals();
    const sse = new SseManager();
    const unsubscribe = vi.fn();
    vi.spyOn(sse, "subscribe").mockReturnValue(unsubscribe);
    const clear = vi.spyOn(global, "clearInterval");
    const port = await serve(sse);

    const stream = await open(port);
    await stream.waitFor((t) => t.includes("data: {}"));
    expect(intervals.some((c) => c.ms === 25_000)).toBe(true);

    stream.close();

    // A leak here would grow an unbounded subscriber set on the
    // long-lived api process.
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalled());
    expect(clear).toHaveBeenCalled();
  });

  it("subscribes each connection under its own caller's person id", async () => {
    const sse = new SseManager();
    const subscribe = vi.spyOn(sse, "subscribe");
    const port = await serve(sse);

    const a = await open(port);
    const b = await open(port);
    await a.waitFor((t) => t.includes("data: {}"));
    await b.waitFor((t) => t.includes("data: {}"));

    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe.mock.calls.map((c) => c[0])).toEqual([PERSON, PERSON]);

    // Both live connections receive the same fan-out.
    sse.publish({ event: "agent.updated", id: "agent_a" }, new Set([PERSON]));
    await a.waitFor((t) => t.includes("agent.updated"));
    await b.waitFor((t) => t.includes("agent.updated"));

    a.close();
    b.close();
  });
});
