import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TaskExecutionWorker } from "./worker.js";

export const DEFAULT_HEALTH_PORT = 3001;

/**
 * Tiny HTTP health endpoint for the executor process. Operators (k8s
 * liveness probes, `pnpm dev` output, on-call dashboards) need an
 * out-of-band way to ask "is this process polling?" — the worker itself
 * doesn't expose anything else over HTTP. Single endpoint, no auth, no
 * routing framework.
 *
 *   GET /health → 200 { ok, polling, last_poll_at, in_flight_count, poll_interval_ms }
 *   anything else → 404
 *
 * "ok" is true iff the worker is `running` AND has polled within
 * 3 × pollIntervalMs (or has never polled but pollInterval is short
 * enough that "never polled" is still legitimately starting). This
 * matches the typical liveness contract: "report unhealthy if a poll
 * is overdue, so the supervisor can restart the process".
 */
export class ExecutorHealthServer {
  private server: Server | null = null;

  constructor(
    private readonly worker: TaskExecutionWorker,
    private readonly requestedPort: number = DEFAULT_HEALTH_PORT,
  ) {}

  /**
   * Bound port. After `start()` returns the actual listen port (useful when
   * `requestedPort` was 0 — OS-assigned, in tests). Before start: returns
   * the requested value.
   */
  get port(): number {
    const addr = this.server?.address();
    if (addr && typeof addr !== "string") return (addr as AddressInfo).port;
    return this.requestedPort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => {
      if (req.url !== "/health" || req.method !== "GET") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const s = this.worker.status();
      const stale =
        s.lastPollAt != null &&
        Date.now() - s.lastPollAt.getTime() > 3 * s.pollIntervalMs;
      const ok = s.running && !stale;
      res.statusCode = ok ? 200 : 503;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok,
          polling: s.running,
          last_poll_at: s.lastPollAt?.toISOString() ?? null,
          in_flight_count: s.inFlightCount,
          poll_interval_ms: s.pollIntervalMs,
        }),
      );
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(this.requestedPort, () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
  }
}
