import type {
  Agent,
  AgentRepository,
  RuntimeRegistry,
  Session,
  SessionRepository,
  Task,
  Workspace,
} from "@beevibe/core";
import {
  AgentSession,
  buildIntent,
  type ResumeReason,
} from "@beevibe/core/services/agent-session";
import type { MemoryAgent } from "@beevibe/core/services/memory";

/** Factory for a per-agent `MemoryAgent`, closing over the shared memory services. */
export type MakeMemoryAgent = (agentId: string) => MemoryAgent;

export interface DispatchDeps {
  agentRepo: AgentRepository;
  sessionRepo: SessionRepository;
  /**
   * Keyed by `agent.runtime_config.type`. Built via
   * `createDefaultRuntimeRegistry` in bootstrap; tests inject a fake map.
   */
  runtimeRegistry: RuntimeRegistry;
  makeMemoryAgent: MakeMemoryAgent;
  /**
   * Optional fire-and-forget hook fired on every terminal session. Wired by
   * the executor's bootstrap to call `postDispatchCheck`. AgentSession passes
   * this through its own `onSessionComplete` dep.
   */
  onSessionComplete?: (session: Session) => Promise<void>;
}

/**
 * Dispatch function the worker calls per claimed task.
 *
 * Agent is passed in (the worker already fetched it for the capacity check +
 * workspace provisioning), avoiding a redundant `findById`. AgentSession will
 * re-fetch internally for `runtime_config.system_prompt_addition` — accepted
 * cost for PK-indexed lookups.
 */
export type TaskDispatcher = (
  task: Task,
  agent: Agent,
  workspace: Workspace,
  abortSignal: AbortSignal,
) => Promise<Session>;

/**
 * Build the per-task dispatcher closed over shared deps.
 *
 * Resume + intent decision (M6.5):
 *
 *   priorSession    = sessionRepo.findLatestForTask(task.id)
 *   priorSessionId  = task.next_dispatch_context?.prior_session_id
 *                  ?? (priorSession?.cli_session_id ? priorSession.id : undefined)
 *   reason          = task.next_dispatch_context
 *                  ?? (priorSessionId ? { kind: 'crash_recovery' } : { kind: 'fresh' })
 *   intent          = buildIntent(task, reason)
 *
 * Two coalesces, no decision tree. `next_dispatch_context` (set by
 * `TaskService.reviseTask` and `EscalationService.resolve`) takes precedence
 * for the explicit revision/post-escalation kinds, including B-side synthetic
 * tasks that have no own prior session row. Fallback resume only fires when
 * the prior session actually started a CLI subprocess (`cli_session_id IS NOT
 * NULL`); crashes before CLI startup → fresh dispatch.
 */
export function createTaskDispatcher(deps: DispatchDeps): TaskDispatcher {
  return async (task, agent, workspace, abortSignal) => {
    const runtime = deps.runtimeRegistry[agent.runtime_config.type];
    if (!runtime) {
      throw new Error(`Unsupported runtime: ${agent.runtime_config.type}`);
    }

    const memoryAgent = deps.makeMemoryAgent(agent.id);
    const agentSession = new AgentSession({
      agentRepo: deps.agentRepo,
      sessionRepo: deps.sessionRepo,
      runtime,
      memoryAgent,
      onSessionComplete: deps.onSessionComplete,
    });

    const priorSession = await deps.sessionRepo.findLatestForTask(task.id);
    const priorSessionId =
      task.next_dispatch_context?.prior_session_id ??
      (priorSession?.cli_session_id ? priorSession.id : undefined);

    const reason: ResumeReason =
      task.next_dispatch_context ??
      (priorSessionId ? { kind: "crash_recovery" } : { kind: "fresh" });

    return agentSession.run({
      agentId: agent.id,
      taskId: task.id,
      type: "task",
      intent: buildIntent(task, reason),
      workspace,
      priorSessionId,
      abortSignal,
    });
  };
}
