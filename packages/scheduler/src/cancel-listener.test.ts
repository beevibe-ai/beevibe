/**
 * Cancel-listener integration test. Real Postgres + real LISTEN/NOTIFY.
 * Fires pg_notify('cancel_task', task_id) and verifies worker.cancelTask
 * gets invoked with the task id.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestPool } from "@beevibe/core/test-helpers";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { CancelListener } from "./cancel-listener.js";
import type { TaskExecutionWorker } from "./worker.js";

describe("CancelListener", () => {
  let pool: Pool;
  let listener: CancelListener | undefined;

  beforeAll(() => {
    pool = createTestPool();
  });

  afterEach(async () => {
    if (listener) {
      await listener.stop();
      listener = undefined;
    }
  });

  function fakeWorker(): { worker: TaskExecutionWorker; cancelCalls: string[] } {
    const cancelCalls: string[] = [];
    const worker = {
      cancelTask: vi.fn(async (taskId: string) => {
        cancelCalls.push(taskId);
        return true;
      }),
    } as unknown as TaskExecutionWorker;
    return { worker, cancelCalls };
  }

  it("fires worker.cancelTask when pg_notify('cancel_task', task_id) is sent", async () => {
    const { worker, cancelCalls } = fakeWorker();
    listener = new CancelListener({
      connectionString: process.env.DATABASE_URL_TEST!,
      worker,
    });
    await listener.start();

    // Wait briefly for LISTEN to register on the dedicated connection.
    await new Promise((r) => setTimeout(r, 50));

    await pool.query(`SELECT pg_notify('cancel_task', $1)`, ["task_42"]);

    // Wait for the notification round-trip.
    for (let i = 0; i < 20; i++) {
      if (cancelCalls.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(cancelCalls).toEqual(["task_42"]);
  });

  it("ignores notifications on other channels", async () => {
    const { worker, cancelCalls } = fakeWorker();
    listener = new CancelListener({
      connectionString: process.env.DATABASE_URL_TEST!,
      worker,
    });
    await listener.start();

    await new Promise((r) => setTimeout(r, 50));

    // Different channel — should be ignored.
    await pool.query(`SELECT pg_notify('escalation_created', $1)`, ["esc_1"]);

    await new Promise((r) => setTimeout(r, 200));
    expect(cancelCalls).toEqual([]);
  });

  it("start() is idempotent — a second call does not double-subscribe", async () => {
    const { worker, cancelCalls } = fakeWorker();
    listener = new CancelListener({
      connectionString: process.env.DATABASE_URL_TEST!,
      worker,
    });
    await listener.start();
    await listener.start(); // no-op

    await new Promise((r) => setTimeout(r, 50));

    await pool.query(`SELECT pg_notify('cancel_task', $1)`, ["task_once"]);

    for (let i = 0; i < 20; i++) {
      if (cancelCalls.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    // A second LISTEN on a second connection would deliver the payload twice.
    await new Promise((r) => setTimeout(r, 100));
    expect(cancelCalls).toEqual(["task_once"]);
  });

  it("stop() cleans up the connection — notifications stop being delivered", async () => {
    const { worker, cancelCalls } = fakeWorker();
    listener = new CancelListener({
      connectionString: process.env.DATABASE_URL_TEST!,
      worker,
    });
    await listener.start();
    await new Promise((r) => setTimeout(r, 50));

    await listener.stop();
    // stop is idempotent
    await listener.stop();

    await pool.query(`SELECT pg_notify('cancel_task', $1)`, ["task_after_stop"]);
    await new Promise((r) => setTimeout(r, 200));

    expect(cancelCalls).toEqual([]);
  });
});
