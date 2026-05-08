import type {
  Agent,
  AgentRepository,
  Session,
  SessionRepository,
  TaskRepository,
  TaskStatus,
  Workspace,
  WorkspaceManager,
} from "@beevibe/core";

/**
 * Default per-agent cap on concurrent task sessions. Matches the old repo's
 * `SessionManager.canAcceptSession` default (intentcore-platform).
 */
export const DEFAULT_TASK_CAP = 1;

/**
 * Default poll interval. Matches the old repo's `POLL_INTERVAL_MS`.
 * Production deployments override via `BootstrapConfig.pollIntervalMs`.
 */
export const DEFAULT_POLL_MS = 30_000;

/**
 * Fire-and-forget dispatch callback the worker hands claimed sessions to.
 * Implementations call AgentSession.run with the already-claimed session
 * (the row is already at status='running'); the dispatcher just spawns
 * the CLI and updates the terminal state on exit. Rejections are caught
 * by the worker and surfaced via `onError`.
 */
export type DispatchFn = (
  session: Session,
  agent: Agent,
  workspace: Workspace,
  abortSignal: AbortSignal,
) => Promise<unknown>;

export interface TaskExecutionWorkerConfig {
  agentRepo: AgentRepository;
  taskRepo: TaskRepository;
  sessionRepo: SessionRepository;
  workspaceManager: WorkspaceManager;
  dispatchTask: DispatchFn;
  /** Default `DEFAULT_POLL_MS` (30s). */
  pollIntervalMs?: number;
  /**
   * Called when a dispatched task rejects. Default: `console.error`. Does not
   * stop the poll loop — the worker keeps running after errors.
   */
  onError?: (err: Error) => void;
}

/**
 * Poll-claim-dispatch-reap loop for the executor.
 *
 * One poll cycle:
 *   1. Reap — detect orphaned sessions whose CLI process died (via
 *      `isProcessAlive`) and mark them failed; re-queue the parent task.
 *   2. Dispatch — list all assignable tasks, for each: check per-agent
 *      capacity (DB running count + poll-local pending), atomically claim
 *      via `TaskRepository.claimById`, provision the workspace, hand off to
 *      `dispatchTask` (fire-and-forget).
 *
 * All session-row bookkeeping (create/update), briefing composition, runtime
 * spawn, and post-session promotion live inside `AgentSession` (M3). The
 * worker doesn't touch any of that.
 */
export class TaskExecutionWorker {
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Map<string, AbortController>();
  private lastPollAt: Date | null = null;
  private readonly pollIntervalMs: number;
  private readonly onError: (err: Error) => void;

  constructor(private readonly config: TaskExecutionWorkerConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.onError =
      config.onError ?? ((err) => console.error("[worker] dispatch error:", err));
  }

  /**
   * Read-only snapshot for the health endpoint. Surfaces enough for an
   * operator (or k8s liveness probe) to tell "is this process polling?"
   * without exposing internal repos.
   */
  status(): {
    running: boolean;
    lastPollAt: Date | null;
    inFlightCount: number;
    pollIntervalMs: number;
  } {
    return {
      running: this.running,
      lastPollAt: this.lastPollAt,
      inFlightCount: this.inFlight.size,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  /**
   * Begin polling. Fires an immediate first poll, then every `pollIntervalMs`.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.poll();
    this.pollTimer = setInterval(() => {
      void this.poll().catch(this.onError);
    }, this.pollIntervalMs);
  }

  /**
   * Stop the poll loop and abort any in-flight dispatches. Does NOT wait for
   * the aborted tasks to settle — callers that need to drain should do so
   * after calling stop().
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const controller of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
  }

  /** One complete poll cycle: reap → dispatch. Public for testing. */
  async poll(): Promise<void> {
    if (!this.running) return;
    this.lastPollAt = new Date();
    await this.reapOrphanedSessions();
    await this.dispatchReady();
  }

  /**
   * Cancel an in-flight task by aborting the controller for any session
   * currently running for it. Returns true on hit. Does NOT update the
   * task / session row — `AgentSession.run` sees the abort signal and
   * writes a `cancelled` status; task transitions are managed elsewhere.
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const sessionRow = await this.config.sessionRepo.findLatestForTask(taskId);
    if (!sessionRow) return false;
    const controller = this.inFlight.get(sessionRow.id);
    if (!controller) return false;
    controller.abort();
    this.inFlight.delete(sessionRow.id);
    return true;
  }

  private async reapOrphanedSessions(): Promise<void> {
    const sessions = await this.config.sessionRepo.listRunningWithPid();
    for (const session of sessions) {
      // Skip sessions this worker is actively managing — aborts go through
      // `cancelTask`, not reap.
      if (session.task_id && this.inFlight.has(session.task_id)) continue;
      if (isProcessAlive(session.process_pid)) continue;

      // CLI process is gone. Mark session failed; re-queue the task (if any)
      // back to the matching queue status so the next poll picks it up
      // again. Crash recovery only — this is different from the M6
      // post-dispatch retry, which handles the agent exiting cleanly
      // without calling update_progress.
      await this.config.sessionRepo.update(session.id, {
        status: "failed",
        error: "process_lost",
        completed_at: new Date(),
      });
      if (session.task_id) {
        // Mirror the claim transition. Anything else (done, cancelled, …)
        // we leave alone — reap shouldn't overwrite a terminal state set
        // by the agent or an operator.
        const REAP_REQUEUE: Partial<Record<TaskStatus, TaskStatus>> = {
          in_progress: "assigned",
          revision: "needs_revision",
        };
        const current = await this.config.taskRepo.findById(session.task_id);
        const next = current && REAP_REQUEUE[current.status];
        if (next) {
          await this.config.taskRepo.update(session.task_id, { status: next });
        }
      }
    }
  }

  private async dispatchReady(): Promise<void> {
    // Phase 4: claim already-pending sessions whose runtime_id is null
    // (legacy / agent without preferred_runtime_id). Daemon-bound
    // sessions (runtime_id set) are claimed by the matching daemon via
    // /runtime/claim — never reach this loop.
    while (this.running) {
      const session = await this.config.sessionRepo.claimNextForServerFallback();
      if (!session) break;
      if (this.inFlight.has(session.id)) continue;

      const agent = await this.config.agentRepo.findById(session.agent_id);
      if (!agent) {
        await this.config.sessionRepo.update(session.id, {
          status: "failed",
          error: "agent_missing_at_claim",
          completed_at: new Date(),
        });
        continue;
      }

      if (!(await this.hasTaskCapacityForClaim(agent, session))) {
        // Over cap — release back to pending; another worker tick will
        // re-claim once capacity frees.
        await this.config.sessionRepo.update(session.id, { status: "pending" });
        break;
      }

      const workspace = await this.config.workspaceManager.ensureWorkspace({ agent });
      const ac = new AbortController();
      this.inFlight.set(session.id, ac);

      void Promise.resolve()
        .then(() => this.config.dispatchTask(session, agent, workspace, ac.signal))
        .catch((err: unknown) =>
          this.onError(err instanceof Error ? err : new Error(String(err))),
        )
        .finally(() => {
          this.inFlight.delete(session.id);
        });
    }
  }

  private async hasTaskCapacityForClaim(
    agent: Agent,
    claimed: Session,
  ): Promise<boolean> {
    if (claimed.type !== "task") return true; // chat / mesh have separate caps elsewhere
    const running = await this.config.sessionRepo.countRunningByAgent(agent.id, ["task"]);
    const cap = agent.max_task_sessions ?? DEFAULT_TASK_CAP;
    // We just promoted this session to running; it's already counted.
    return running <= cap;
  }
}

/**
 * Check whether a process is still alive via signal 0.
 * Ported from intentcore-platform `task-execution-worker.ts`.
 *
 * Returns true if the process exists (or exists but is in another uid, which
 * surfaces as EPERM — treated as alive to avoid spurious reaps).
 * Returns false for invalid pids and for ESRCH ("no such process").
 */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EPERM") return true;
    return false;
  }
}
