import type {
  Agent,
  AgentRepository,
  RuntimeRegistry,
  Session,
  SessionRepository,
  Task,
  Workspace,
} from "@beevibe/core";
import { AgentSession } from "@beevibe/core/services/agent-session";
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
 * Flow:
 *   1. Resolve runtime from `runtimeRegistry[agent.runtime_config.type]`.
 *      Throws `Unsupported runtime: <type>` if not registered.
 *   2. Build a per-agent `MemoryAgent` (agentId baked in).
 *   3. Construct `AgentSession` with the resolved runtime + memory agent.
 *   4. For revision tasks, look up the latest prior session so AgentSession
 *      can issue `--resume` to continue the conversation.
 *   5. Call `agentSession.run({...})`. All session-row lifecycle, briefing,
 *      runtime spawn, and post-session promotion happen inside.
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
    });

    const priorSessionId =
      task.status === "revision"
        ? (await deps.sessionRepo.findLatestForTask(task.id))?.id
        : undefined;

    return agentSession.run({
      agentId: agent.id,
      taskId: task.id,
      intent: composeIntent(task),
      workspace,
      priorSessionId,
      abortSignal,
    });
  };
}

function composeIntent(task: Task): string {
  return task.description ? `${task.title}\n\n${task.description}` : task.title;
}
