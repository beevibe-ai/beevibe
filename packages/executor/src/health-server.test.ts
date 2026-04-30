import { afterEach, describe, expect, it } from "vitest";
import { ExecutorHealthServer } from "./health-server.js";
import type { TaskExecutionWorker } from "./worker.js";

function fakeWorker(
  status: ReturnType<TaskExecutionWorker["status"]>,
): TaskExecutionWorker {
  return { status: () => status } as unknown as TaskExecutionWorker;
}

async function getJson(port: number, path: string) {
  const res = await fetch(`http://localhost:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

describe("ExecutorHealthServer", () => {
  let server: ExecutorHealthServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it("returns 200 + status JSON when worker is healthy and recently polled", async () => {
    server = new ExecutorHealthServer(
      fakeWorker({
        running: true,
        lastPollAt: new Date(),
        inFlightCount: 2,
        pollIntervalMs: 30_000,
      }),
      0, // OS-assigned port
    );
    await server.start();

    const res = await getJson(server.port, "/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      polling: true,
      in_flight_count: 2,
      poll_interval_ms: 30_000,
    });
    expect(res.body.last_poll_at).toBeTruthy();
  });

  it("returns 503 when the worker hasn't polled in 3× the interval (stale)", async () => {
    const stale = new Date(Date.now() - 100_000);
    server = new ExecutorHealthServer(
      fakeWorker({
        running: true,
        lastPollAt: stale,
        inFlightCount: 0,
        pollIntervalMs: 30_000, // 3× = 90_000ms; stale is 100s old → unhealthy
      }),
      0,
    );
    await server.start();

    const res = await getJson(server.port, "/health");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  it("returns 503 when the worker is not running", async () => {
    server = new ExecutorHealthServer(
      fakeWorker({
        running: false,
        lastPollAt: null,
        inFlightCount: 0,
        pollIntervalMs: 30_000,
      }),
      0,
    );
    await server.start();

    const res = await getJson(server.port, "/health");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, polling: false });
  });

  it("returns 404 for unknown paths", async () => {
    server = new ExecutorHealthServer(
      fakeWorker({
        running: true,
        lastPollAt: new Date(),
        inFlightCount: 0,
        pollIntervalMs: 30_000,
      }),
      0,
    );
    await server.start();

    const res = await fetch(`http://localhost:${server.port}/nope`);
    expect(res.status).toBe(404);
  });
});
