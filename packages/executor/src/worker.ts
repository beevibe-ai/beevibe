import type {
  Agent,
  AgentRepository,
  SessionRepository,
  Task,
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
 * Fire-and-forget dispatch callback the worker hands claimed tasks to.
 * Implementations build the per-task `AgentSession` + `MemoryAgent` and call
 * `agentSession.run(...)`. The resolved value is ignored; rejections are
 * caught by the worker and surfaced via `onError`.
 */
export type DispatchFn = (
  task: Task,
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
  private readonly pollIntervalMs: number;
  private readonly onError: (err: Error) => void;

  constructor(private readonly config: TaskExecutionWorkerConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.onError =
      config.onError ?? ((err) => console.error("[worker] dispatch error:", err));
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
    await this.reapOrphanedSessions();
    await this.dispatchReady();
  }

  /**
   * Cancel an in-flight task by aborting its controller. Returns true if the
   * task was in-flight and got aborted, false otherwise. Does NOT update the
   * task or session row — the dispatched `AgentSession.run` sees the abort
   * signal and writes a `cancelled` session status; task status transitions
   * are M6's concern (via `update_progress` or post-dispatch check).
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const controller = this.inFlight.get(taskId);
    if (!controller) return false;
    controller.abort();
    this.inFlight.delete(taskId);
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
    const candidates = await this.config.taskRepo.listAssignable();
    // Poll-scoped: seeded lazily from DB on first access per agent, incremented
    // on dispatch. Single map avoids the double-count race a separate "pending"
    // map would have when a DB INSERT commits between iterations.
    const runningByAgent = new Map<string, number>();

    for (const task of candidates) {
      if (!this.running) break;
      if (this.inFlight.has(task.id)) continue;

      const agentId = task.assignee_id;
      if (!agentId) continue;
      const agent = await this.config.agentRepo.findById(agentId);
      if (!agent) continue;

      if (!(await this.hasTaskCapacity(agent, runningByAgent))) continue;

      const claimed = await this.config.taskRepo.claimById(task.id);
      if (!claimed) continue; // race loser — another executor won the claim

      const workspace = await this.config.workspaceManager.ensureWorkspace({ agent });
      const ac = new AbortController();
      this.inFlight.set(task.id, ac);
      runningByAgent.set(agent.id, (runningByAgent.get(agent.id) ?? 0) + 1);

      // Fire-and-forget. `.finally` always clears inFlight.
      void Promise.resolve()
        .then(() => this.config.dispatchTask(claimed, agent, workspace, ac.signal))
        .catch((err: unknown) =>
          this.onError(err instanceof Error ? err : new Error(String(err))),
        )
        .finally(() => {
          this.inFlight.delete(task.id);
        });
    }
  }

  private async hasTaskCapacity(
    agent: Agent,
    runningByAgent: Map<string, number>,
  ): Promise<boolean> {
    let current = runningByAgent.get(agent.id);
    if (current === undefined) {
      current = await this.config.sessionRepo.countRunningByAgent(agent.id, ["task"]);
      runningByAgent.set(agent.id, current);
    }
    const cap = agent.max_task_sessions ?? DEFAULT_TASK_CAP;
    return current < cap;
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
