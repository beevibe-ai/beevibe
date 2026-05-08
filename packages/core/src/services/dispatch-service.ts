/**
 * DispatchService — central session-creation point for the daemon-first
 * runtime model.
 *
 * Today the existing executor still polls `task.status='assigned'` and
 * creates session rows inline at claim time (`AgentSession.run`). When
 * Phase 4+ wires this service into the call sites (create_task,
 * revise_task, mesh's spawnTargetSession, escalation.resolve, post-
 * dispatch retry) the tool handlers will INSERT a session row up
 * front (status='pending', runtime_id resolved here) and the daemon
 * — or the legacy executor as a transitional fallback — claims it.
 *
 * `dispatchTask` resolves runtime_id with the resume-pinning rule:
 *   - resume reasons (revision, post_escalation, crash_recovery): pin
 *     to `prior_session.runtime_id` so `claude --resume` reads the
 *     conversation .jsonl from the same machine that ran the prior
 *     session.
 *   - fresh: use the agent's `preferred_runtime_id`.
 *
 * In Phase 3 the service is purely infrastructure — built, tested,
 * exported, but not yet wired to any call site. Phase 4 wires it.
 */

import type { Session, SessionType } from "../domain/session.js";
import type { Task } from "../domain/task.js";
import { sessionId as newSessionId } from "../domain/ids.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type { ResumeReason } from "./agent-session.js";

export interface DispatchServiceDeps {
  agentRepo: AgentRepository;
  sessionRepo: SessionRepository;
  /**
   * Best-effort wakeup hook fired immediately after a pending session row
   * lands. Phase 4 binds this to the WS hub's `notify(runtime_id, …)`
   * frame; tests inject a stub. Errors are caught and logged here so
   * the dispatch path can never reject mid-INSERT-then-notify.
   */
  onSessionInserted?: (session: Session) => void | Promise<void>;
}

export interface DispatchInput {
  /** Task being dispatched. May be omitted for chat / mesh sessions later. */
  task?: Task;
  agentId: string;
  /**
   * Pre-composed user-facing intent (the CLI's stdin). The caller is
   * responsible for shaping this — for tasks, use `buildIntent(task,
   * reason)` from agent-session.ts.
   */
  intent: string;
  reason: ResumeReason;
  type: SessionType;
  /**
   * Override the resolved runtime_id. Used by mesh + chat in later
   * phases when the spawn site has more context than the agent's
   * default binding.
   */
  runtimeIdOverride?: string;
}

/**
 * Wire-format for a freshly-inserted dispatchable session. Mirrors the
 * shape Phase 4's WS-hub frame will carry (runtime_id, session_id) so
 * the daemon can immediately claim by id.
 */
export interface DispatchResult {
  session: Session;
  runtime_id: string | null;
}

export class DispatchService {
  constructor(private readonly deps: DispatchServiceDeps) {}

  /**
   * Insert a `status='pending'` session row + fire the wakeup hook.
   * Phase 4 onwards: the hook drives `hub.notify(runtime_id, session.id)`;
   * the daemon then `POST /runtime/claim`s and flips to `'running'`.
   * In Phase 3 the hook is unused at runtime — the legacy executor
   * still owns the claim+spawn flow.
   */
  async dispatchTask(input: DispatchInput): Promise<DispatchResult> {
    const agent = await this.deps.agentRepo.findById(input.agentId);
    if (!agent) {
      throw new Error(`DispatchService: agent not found: ${input.agentId}`);
    }

    const runtime_id = await this.resolveRuntimeId(input);

    const session = await this.deps.sessionRepo.create({
      id: newSessionId(),
      agent_id: input.agentId,
      task_id: input.task?.id,
      prior_session_id: extractPriorSessionId(input.reason),
      type: input.type,
      intent: input.intent,
      // status defaults to 'pending' (migration 1779200000000); explicit
      // here so the contract is visible at the call site.
      status: "pending",
      runtime_id: runtime_id ?? undefined,
      spawn_mode: "daemon",
    });

    if (this.deps.onSessionInserted) {
      try {
        await this.deps.onSessionInserted(session);
      } catch (err) {
        // Wakeup is best-effort; the daemon's 30s poll catches anything
        // the WS push misses. We never want a hub error to fail the
        // dispatch.
        console.warn(
          `[DispatchService] onSessionInserted failed for ${session.id}:`,
          (err as Error).message,
        );
      }
    }

    return { session, runtime_id: runtime_id ?? null };
  }

  /**
   * Resume sessions pin to `prior_session.runtime_id` so `claude --resume`
   * lands on the same machine as the prior CLI run. Fresh sessions
   * fall back to the agent's `preferred_runtime_id` (which is null today
   * since no daemons are registered; that NULL is fine — a NULL
   * runtime_id means "server-fallback-mesh path" in the dispatch model
   * once Phase 4 lands).
   */
  private async resolveRuntimeId(input: DispatchInput): Promise<string | null> {
    if (input.runtimeIdOverride !== undefined) return input.runtimeIdOverride;

    const priorSessionId = extractPriorSessionId(input.reason);
    if (priorSessionId) {
      const prior = await this.deps.sessionRepo.findById(priorSessionId);
      if (prior?.runtime_id) return prior.runtime_id;
      // Fall through to the agent's default if the prior session is
      // gone or never had a runtime_id stamped (e.g. legacy in-process
      // sessions from the pre-daemon executor).
    }

    const agent = await this.deps.agentRepo.findById(input.agentId);
    return agent?.preferred_runtime_id ?? null;
  }
}

function extractPriorSessionId(reason: ResumeReason): string | undefined {
  switch (reason.kind) {
    case "fresh":
    case "crash_recovery":
      return undefined;
    case "revision":
    case "post_escalation":
      return reason.prior_session_id;
  }
}
