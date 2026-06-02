/**
 * WatchService — backs the `watch_tasks` + `unwatch` MCP tools. Inserts
 * a `task_watch` row representing the agent's "wake me when these
 * finish" subscription; a DB trigger handles the fire when watched
 * tasks transition terminal afterwards. The already-terminal path —
 * agent calls watch_tasks but the tasks are *already* done/failed/
 * cancelled — is handled here in TS, calling the same SQL intent
 * formatter the trigger uses so the wake intent is byte-identical
 * regardless of which path fired.
 */

import {
  TERMINAL_TASK_STATUSES,
  sessionId as newSessionId,
  taskWatchId,
  type Session,
  type Task,
  type TaskWatchMode,
} from "../domain/index.js";
import type { Pool } from "../adapters/postgres/client.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type { TaskRepository } from "../ports/task-repo.js";
import type { TaskWatchRepository } from "../ports/task-watch-repo.js";

export interface WatchServiceDeps {
  pool: Pool;
  sessionRepo: SessionRepository;
  taskRepo: TaskRepository;
  watchRepo: TaskWatchRepository;
}

export interface WatchTasksInput {
  callerAgentId: string;
  callerSessionId: string;
  taskIds: string[];
  mode: TaskWatchMode;
  reason?: string;
}

export interface WatchTasksResult {
  watchId: string;
  firedImmediately: boolean;
}

export interface UnwatchInput {
  callerAgentId: string;
  watchId: string;
}

const TERMINAL_SET = new Set<string>(TERMINAL_TASK_STATUSES);

export class WatchAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchAuthError";
  }
}

export class WatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchValidationError";
  }
}

export class WatchNotFoundError extends Error {
  constructor(id: string) {
    super(`task_watch ${id} not found`);
    this.name = "WatchNotFoundError";
  }
}

export class WatchService {
  constructor(private deps: WatchServiceDeps) {}

  async watchTasks(input: WatchTasksInput): Promise<WatchTasksResult> {
    if (input.taskIds.length === 0) {
      throw new WatchValidationError("task_ids must be non-empty");
    }

    const waiter = await this.deps.sessionRepo.findById(input.callerSessionId);
    if (!waiter) {
      throw new WatchAuthError(
        `caller session ${input.callerSessionId} not found`,
      );
    }
    if (waiter.agent_id !== input.callerAgentId) {
      throw new WatchAuthError(
        "caller session does not belong to caller agent",
      );
    }

    const inScope = await this.findTasksInChain(waiter.id, input.taskIds);
    const missing = input.taskIds.filter((id) => !inScope.has(id));
    if (missing.length > 0) {
      throw new WatchAuthError(
        `task(s) not dispatched in your conversation chain: ${missing.join(", ")}`,
      );
    }

    const watch = await this.deps.watchRepo.create({
      id: taskWatchId(),
      waiter_session_id: waiter.id,
      agent_id: waiter.agent_id,
      mode: input.mode,
      task_ids: input.taskIds,
      reason: input.reason,
    });

    const fetched = await this.deps.taskRepo.findByIds(input.taskIds);
    const byId = new Map(fetched.map((t) => [t.id, t]));
    const tasks = input.taskIds.map((id) => byId.get(id));
    const terminalTasks = tasks.filter(
      (t): t is Task => !!t && TERMINAL_SET.has(t.status),
    );
    const shouldFire =
      input.mode === "any"
        ? terminalTasks.length > 0
        : tasks.every((t) => !!t) && terminalTasks.length === tasks.length;

    if (shouldFire) {
      const firingTask = terminalTasks[0]!;
      const wake = await this.fireWatch(waiter, watch.id, firingTask.id);
      await this.deps.watchRepo.markFired(watch.id, wake.id);
      return { watchId: watch.id, firedImmediately: true };
    }

    return { watchId: watch.id, firedImmediately: false };
  }

  async unwatch(input: UnwatchInput): Promise<void> {
    const watch = await this.deps.watchRepo.findById(input.watchId);
    if (!watch) throw new WatchNotFoundError(input.watchId);
    if (watch.agent_id !== input.callerAgentId) {
      throw new WatchAuthError("watch does not belong to caller");
    }
    if (watch.status === "aborted") return; // idempotent
    if (watch.status === "fired") {
      throw new WatchValidationError(
        `cannot unwatch a watch that already fired (wake session ${watch.fired_session_id})`,
      );
    }
    await this.deps.watchRepo.markAborted(input.watchId);
  }

  /**
   * Collect the task ids whose dispatching session (session.parent_session_id)
   * is anywhere in the waiter's `prior_session_id` chain. Single recursive
   * CTE walk; returns the subset that's in scope so the caller can diff
   * against the input list to identify cross-conversation watches.
   */
  private async findTasksInChain(
    waiterSessionId: string,
    taskIds: string[],
  ): Promise<Set<string>> {
    const { rows } = await this.deps.pool.query<{ task_id: string }>(
      `WITH RECURSIVE chain(id) AS (
         SELECT id FROM session WHERE id = $1
         UNION ALL
         SELECT s.prior_session_id
         FROM session s
         JOIN chain c ON c.id = s.id
         WHERE s.prior_session_id IS NOT NULL
       )
       SELECT DISTINCT s.task_id
         FROM session s
        WHERE s.task_id = ANY($2::text[])
          AND s.parent_session_id IN (SELECT id FROM chain)`,
      [waiterSessionId, taskIds],
    );
    return new Set(rows.map((r) => r.task_id));
  }

  /**
   * Insert the wake session for an already-terminal watch. Calls the
   * SQL intent formatter `bv_build_watch_intent` so chat-side fires
   * and trigger-side fires produce byte-identical wake messages.
   */
  private async fireWatch(
    waiter: Session,
    watchId: string,
    firingTaskId: string,
  ): Promise<Session> {
    const intent = await this.formatWakeIntent(watchId, firingTaskId);
    return this.deps.sessionRepo.create({
      id: newSessionId(),
      agent_id: waiter.agent_id,
      task_id: waiter.task_id,
      prior_session_id: waiter.id,
      // Chat / task chains are runtime-pinned so claude --resume hits the
      // same daemon (and the same on-disk CLI session file) every turn.
      // The trigger does the same; this is the service-side mirror for the
      // already-terminal race. We intentionally use raw inheritance — NOT
      // dispatchService's resolveRuntimeId fallback chain (override →
      // prior → agent.preferred_runtime_id) — because the wake's semantic
      // is "match the chain exactly". If the chain was deliberately null-
      // routed (server-fallback), falling through to the agent's
      // preferred runtime would silently re-route mid-conversation.
      runtime_id: waiter.runtime_id,
      type: waiter.type,
      intent,
      status: "pending",
    });
  }

  private async formatWakeIntent(
    watchId: string,
    firingTaskId: string,
  ): Promise<string> {
    const { rows } = await this.deps.pool.query<{ intent: string }>(
      `SELECT bv_build_watch_intent($1, $2) AS intent`,
      [watchId, firingTaskId],
    );
    return rows[0]!.intent;
  }
}
