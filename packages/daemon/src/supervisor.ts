/**
 * Bounds the number of concurrent CLI subprocesses on this machine.
 * Default cap is 10 — generous for a single user's laptop, low enough
 * to not crater the system if every agent spawns at once.
 *
 * Override via env: BEEVIBE_DAEMON_MAX_CONCURRENT.
 */

export const DEFAULT_MAX_CONCURRENT = 10;

export class Supervisor {
  private active = new Map<string, AbortController>();

  constructor(private readonly maxConcurrent: number = readMaxFromEnv()) {}

  hasCapacity(): boolean {
    return this.active.size < this.maxConcurrent;
  }

  inFlight(): number {
    return this.active.size;
  }

  /**
   * Track a session as in-flight. Returns the AbortController so the
   * caller can wire `runDispatch(abortSignal=ctrl.signal)`.
   */
  start(sessionId: string): AbortController {
    if (!this.hasCapacity()) {
      throw new Error("supervisor at capacity");
    }
    const ctrl = new AbortController();
    this.active.set(sessionId, ctrl);
    return ctrl;
  }

  finish(sessionId: string): void {
    this.active.delete(sessionId);
  }

  cancel(sessionId: string): boolean {
    const ctrl = this.active.get(sessionId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  cancelAll(): void {
    for (const ctrl of this.active.values()) ctrl.abort();
    this.active.clear();
  }
}

function readMaxFromEnv(): number {
  const raw = process.env.BEEVIBE_DAEMON_MAX_CONCURRENT;
  if (!raw) return DEFAULT_MAX_CONCURRENT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CONCURRENT;
  return n;
}
