/**
 * DispatchService — central session-creation point.
 *
 * Inserts a `status='pending'` session row, resolves the target
 * `runtime_id` (pinning resume reasons to the prior session's machine
 * so `claude --resume` finds its conversation `.jsonl` on local disk),
 * and notifies the daemon hub so it can claim the row immediately.
 */

import type { Agent } from "../domain/agent.js";
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
   * Best-effort wakeup hook fired after a pending session lands. Errors
   * are caught and logged so dispatch never fails on hub flakiness.
   */
  onSessionInserted?: (session: Session) => void | Promise<void>;
}

export interface DispatchInput {
  /** Optional for chat / mesh sessions that aren't task-bound. */
  task?: Task;
  agentId: string;
  /**
   * Pre-composed user-facing intent (the CLI's stdin). For tasks, the
   * caller produces this via `buildIntent(task, reason)` from
   * agent-session.ts.
   */
  intent: string;
  reason: ResumeReason;
  type: SessionType;
  /**
   * Override the resolved runtime_id. Used by mesh + chat call sites
   * when the spawn site has more context than the agent's default
   * binding.
   */
  runtimeIdOverride?: string;
}

export interface DispatchResult {
  session: Session;
  runtime_id: string | null;
}

export class DispatchService {
  constructor(private readonly deps: DispatchServiceDeps) {}

  async dispatchTask(input: DispatchInput): Promise<DispatchResult> {
    const priorSessionId = extractPriorSessionId(input.reason);

    // Parallelize the agent + prior-session fetches when we need both;
    // halves the resume-path roundtrip cost.
    const [agent, prior] = await Promise.all([
      this.deps.agentRepo.findById(input.agentId),
      priorSessionId
        ? this.deps.sessionRepo.findById(priorSessionId)
        : Promise.resolve(undefined),
    ]);
    if (!agent) {
      throw new Error(`DispatchService: agent not found: ${input.agentId}`);
    }

    const runtime_id = resolveRuntimeId(input, agent, prior?.runtime_id);

    const session = await this.deps.sessionRepo.create({
      id: newSessionId(),
      agent_id: input.agentId,
      task_id: input.task?.id,
      prior_session_id: priorSessionId,
      type: input.type,
      intent: input.intent,
      status: "pending",
      runtime_id: runtime_id ?? undefined,
      spawn_mode: "daemon",
    });

    if (this.deps.onSessionInserted) {
      try {
        await this.deps.onSessionInserted(session);
      } catch (err) {
        // Wakeup is best-effort; the daemon's poll catches anything the
        // WS push misses. Never let a hub error fail dispatch.
        console.warn(
          `[DispatchService] onSessionInserted failed for ${session.id}:`,
          (err as Error).message,
        );
      }
    }

    return { session, runtime_id: runtime_id ?? null };
  }
}

function resolveRuntimeId(
  input: DispatchInput,
  agent: Agent,
  priorRuntimeId: string | undefined,
): string | null {
  if (input.runtimeIdOverride !== undefined) return input.runtimeIdOverride;
  if (priorRuntimeId) return priorRuntimeId;
  return agent.preferred_runtime_id ?? null;
}

function extractPriorSessionId(reason: ResumeReason): string | undefined {
  return "prior_session_id" in reason ? reason.prior_session_id : undefined;
}
