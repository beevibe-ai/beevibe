/**
 * DispatchService — central session-creation point.
 *
 * Inserts a `status='pending'` session row, resolves the target
 * `runtime_id` (pinning resume reasons to the prior session's machine
 * so `claude --resume` finds its conversation `.jsonl` on local disk),
 * advances the task state machine when dispatching a task, and
 * notifies the daemon hub so it can claim the row immediately.
 */

import type { Agent } from "../domain/agent.js";
import type { Session, SessionType } from "../domain/session.js";
import type { Task, TaskStatus } from "../domain/task.js";
import { sessionId as newSessionId } from "../domain/ids.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type { TaskRepository } from "../ports/task-repo.js";
import type { ResumeReason } from "./agent-session.js";

export interface DispatchServiceDeps {
  agentRepo: AgentRepository;
  sessionRepo: SessionRepository;
  /**
   * Required for type='task' dispatches (the call site advances the task
   * from queue state to active state — assigned→in_progress,
   * needs_revision→revision, blocker_resolved→in_progress). Optional
   * because chat / mesh dispatches are task-less.
   */
  taskRepo?: TaskRepository;
  /**
   * Best-effort wakeup hook fired after a pending session lands. Errors
   * are caught and logged so dispatch never fails on hub flakiness.
   */
  onSessionInserted?: (session: Session) => void | Promise<void>;
  /**
   * Liveness predicate for the resolved runtime. When provided and the
   * resolved runtime returns `false`, mesh-typed dispatches demote to
   * `runtime_id = null` + `spawn_mode = 'server_fallback_mesh'` so the
   * server-fallback worker picks them up with a restricted tool surface.
   * Task / chat dispatches do NOT demote — for those we want the row to
   * stay pinned and wait for the daemon to come back.
   */
  isRuntimeOnline?: (runtimeId: string) => boolean;
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
  /**
   * Pre-generated session id. Used by `MeshServer.sendNegotiate` which
   * needs B's session id BEFORE the spawn so it can stamp
   * counterparty_session_id on the negotiation row.
   */
  sessionIdOverride?: string;
  /**
   * For mesh-typed sessions: the agent that initiated the ask. Stamped
   * on `session.caller_agent_id` so the mesh activity view can read
   * the column directly instead of regex-extracting from intent XML.
   */
  callerAgentId?: string;
  /**
   * Stamped on `session.room_id` when the dispatch was kicked off
   * inside a room context.
   */
  roomId?: string;
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

    const resolved = resolveRuntimeId(input, agent, prior?.runtime_id);
    const isMesh = input.type === "mesh_ask" || input.type === "mesh_negotiate";
    const offline =
      resolved !== null &&
      this.deps.isRuntimeOnline !== undefined &&
      !this.deps.isRuntimeOnline(resolved);
    const fallback = isMesh && offline;
    const runtime_id = fallback ? null : resolved;
    const spawn_mode = fallback ? "server_fallback_mesh" : "daemon";

    const session = await this.deps.sessionRepo.create({
      id: input.sessionIdOverride ?? newSessionId(),
      agent_id: input.agentId,
      task_id: input.task?.id,
      prior_session_id: priorSessionId,
      type: input.type,
      intent: input.intent,
      status: "pending",
      runtime_id: runtime_id ?? undefined,
      spawn_mode,
      ...(input.callerAgentId ? { caller_agent_id: input.callerAgentId } : {}),
      ...(input.roomId ? { room_id: input.roomId } : {}),
    });

    if (input.task && input.type === "task") {
      const next = transitionForDispatch(input.task.status);
      if (next && this.deps.taskRepo) {
        await this.deps.taskRepo.update(input.task.id, { status: next });
      }
    }

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

/**
 * Maps task queue states to active states. Returns undefined for
 * statuses that don't transition on dispatch (in_progress / revision are
 * already active; terminal states shouldn't be re-dispatched). Mirrors
 * the legacy executor's claimById CASE logic.
 */
function transitionForDispatch(current: TaskStatus): TaskStatus | undefined {
  if (current === "assigned") return "in_progress";
  if (current === "needs_revision") return "revision";
  return undefined;
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
