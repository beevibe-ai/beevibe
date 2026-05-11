/**
 * Daemon-orphan reaper.
 *
 * The legacy reaper in `worker.reapOrphanedSessions` watches for in-process
 * CLI subprocesses whose PID died (via signal-0). Daemon sessions don't have
 * a server-side PID — they run on the user's machine — so they need a
 * different liveness signal.
 *
 * A session is daemon-orphaned when:
 *   1. it's `status='running'` AND `runtime_id IS NOT NULL`
 *   2. its own `last_event_at` (or `created_at` fallback) is older than
 *      `sessionStaleSeconds` (5min default)
 *   3. the bound runtime's `last_heartbeat` is older than
 *      `runtimeHeartbeatStaleSeconds` (60s default — 4× the 15s heartbeat
 *      cadence shipped with the daemon binary)
 *
 * Both axes must agree before we reap. (1)+(2) alone could be a slow agent
 * with a fresh heartbeat — perfectly normal. Adding (3) ensures we only act
 * when the daemon is also silent, which is the actual crash signal.
 *
 * On reap we:
 *   - mark the session `failed` with `error='daemon_orphaned'`
 *   - call `onSessionReaped(session)` (bootstrap wires this to ChatResolver
 *     so awaiting chat POSTs unblock immediately rather than hanging out
 *     the 25-minute timeout)
 *   - for type='task' sessions, re-dispatch via DispatchService with
 *     `kind:'crash_recovery'` + `prior_session_id` so the runtime stays
 *     pinned and the daemon resumes when it reconnects
 *   - for chat / mesh, no re-dispatch — the user can retry / mesh asker
 *     will time out on its own resolver
 */

import type { Session } from "../domain/session.js";
import type { TaskStatus } from "../domain/task.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type { TaskRepository } from "../ports/task-repo.js";
import type { DispatchService } from "./dispatch-service.js";
import { buildIntent } from "./agent-session.js";

export const DEFAULT_REAPER_POLL_MS = 60_000;
export const DEFAULT_SESSION_STALE_SECONDS = 5 * 60;
export const DEFAULT_RUNTIME_HEARTBEAT_STALE_SECONDS = 60;

export interface DaemonOrphanReaperConfig {
  sessionRepo: SessionRepository;
  taskRepo: TaskRepository;
  dispatchService: DispatchService;
  /**
   * Best-effort hook fired after a session is marked failed. The api
   * binds this to ChatResolver.resolve so the chat POST unblocks instead
   * of waiting out its 25-minute resolver timeout. Errors are caught.
   */
  onSessionReaped?: (session: Session) => void | Promise<void>;
  /** Default `DEFAULT_REAPER_POLL_MS` (60s). */
  pollIntervalMs?: number;
  /** Default `DEFAULT_SESSION_STALE_SECONDS` (300s). */
  sessionStaleSeconds?: number;
  /** Default `DEFAULT_RUNTIME_HEARTBEAT_STALE_SECONDS` (60s). */
  runtimeHeartbeatStaleSeconds?: number;
  /** Default: console.error. */
  onError?: (err: Error) => void;
}

const REAP_REQUEUE: Partial<Record<TaskStatus, TaskStatus>> = {
  in_progress: "assigned",
  revision: "needs_revision",
};

export class DaemonOrphanReaper {
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pollIntervalMs: number;
  private readonly sessionStaleSeconds: number;
  private readonly runtimeHeartbeatStaleSeconds: number;
  private readonly onError: (err: Error) => void;

  constructor(private readonly config: DaemonOrphanReaperConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_REAPER_POLL_MS;
    this.sessionStaleSeconds =
      config.sessionStaleSeconds ?? DEFAULT_SESSION_STALE_SECONDS;
    this.runtimeHeartbeatStaleSeconds =
      config.runtimeHeartbeatStaleSeconds ??
      DEFAULT_RUNTIME_HEARTBEAT_STALE_SECONDS;
    this.onError =
      config.onError ??
      ((err) => console.error("[daemon-orphan-reaper]", err));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.tick();
    this.pollTimer = setInterval(() => {
      void this.tick().catch(this.onError);
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** One reap pass. Public for tests. */
  async tick(): Promise<{ reaped: number; redispatched: number }> {
    const orphans = await this.config.sessionRepo.listDaemonOrphaned({
      sessionStaleSeconds: this.sessionStaleSeconds,
      runtimeHeartbeatStaleSeconds: this.runtimeHeartbeatStaleSeconds,
    });
    let reaped = 0;
    let redispatched = 0;
    for (const session of orphans) {
      try {
        const updated = await this.config.sessionRepo.update(session.id, {
          status: "failed",
          error: "daemon_orphaned",
          completed_at: new Date(),
        });
        reaped++;

        if (this.config.onSessionReaped) {
          try {
            await this.config.onSessionReaped(updated);
          } catch (err) {
            this.onError(asError(err));
          }
        }

        if (session.type === "task" && session.task_id) {
          // Re-queue the parent task to its assignable state — the
          // crash_recovery dispatch creates a new pending session pinned
          // to the same runtime via prior_session_id.
          const task = await this.config.taskRepo.findById(session.task_id);
          if (task) {
            const next = REAP_REQUEUE[task.status];
            if (next) {
              await this.config.taskRepo.update(session.task_id, {
                status: next,
              });
            }
            if (task.assignee_id) {
              await this.config.dispatchService.dispatchTask({
                agentId: task.assignee_id,
                intent: buildIntent(
                  { id: task.id, title: task.title, description: task.description },
                  { kind: "crash_recovery", prior_session_id: session.id },
                ),
                reason: { kind: "crash_recovery", prior_session_id: session.id },
                type: "task",
                task,
              });
              redispatched++;
            }
          }
        }
      } catch (err) {
        this.onError(asError(err));
      }
    }
    return { reaped, redispatched };
  }
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
