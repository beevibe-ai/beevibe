/**
 * Listens on PostgreSQL `LISTEN cancel_task` for cross-process cancellation
 * signals from @beevibe/api's `POST /task/:id/cancel`. Fast path:
 *
 *   api server: UPDATE task SET status='cancelled' + pg_notify('cancel_task', task_id)
 *   pg propagates → cancelListener notification handler fires
 *   listener calls worker.cancelTask(task_id) → AbortController.abort()
 *   AgentSession's runtime sees abort → CLI subprocess killed
 *
 * Latency target: <200ms end-to-end. Idempotent at every layer:
 *   - api UPDATE is conditional on `status != 'cancelled'`
 *   - worker.cancelTask returns false if not in inFlight (already finished
 *     or never started on this executor)
 *
 * Failure modes documented in plan:
 *   - executor down when notification fires → notification lost (LISTEN/
 *     NOTIFY is fire-and-forget). Task still durable as cancelled in DB,
 *     so any future poll won't re-claim. Reap handles dead subprocess.
 *   - notification arrives before LISTEN registered (~10ms startup window)
 *     → lost. Acceptable.
 *
 * Uses a DEDICATED pg.Client (not the pool) because LISTEN holds the
 * connection for the lifetime of the process; pooling defeats the purpose.
 */

import { Client as PgClient } from "pg";
import type { TaskExecutionWorker } from "./worker.js";

export interface CancelListenerConfig {
  connectionString: string;
  worker: TaskExecutionWorker;
}

export class CancelListener {
  private client?: PgClient;
  private started = false;

  constructor(private readonly config: CancelListenerConfig) {}

  /**
   * Connects to Postgres and subscribes to the `cancel_task` channel.
   * Idempotent — calling twice is a no-op.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.client = new PgClient({ connectionString: this.config.connectionString });
    await this.client.connect();

    this.client.on("notification", (msg) => {
      if (msg.channel !== "cancel_task" || !msg.payload) return;
      const taskId = msg.payload;
      void this.config.worker.cancelTask(taskId).catch((err: unknown) => {
        console.error(
          `[cancel-listener] cancelTask(${taskId}) failed:`,
          err instanceof Error ? err.message : err,
        );
      });
    });

    // Surface unexpected disconnects so operators can see them. Reconnect
    // logic is M-future; for now, assume the process restarts.
    this.client.on("error", (err) => {
      console.error("[cancel-listener] connection error:", err.message);
    });

    await this.client.query("LISTEN cancel_task");
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      await this.client?.query("UNLISTEN cancel_task");
    } catch {
      // best-effort
    }
    try {
      await this.client?.end();
    } catch {
      // best-effort
    }
    this.client = undefined;
  }
}
