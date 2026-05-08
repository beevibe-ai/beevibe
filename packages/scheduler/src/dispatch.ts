import type {
  Agent,
  AgentRepository,
  RuntimeRegistry,
  Session,
  SessionEventRepository,
  SessionRepository,
  Workspace,
} from "@beevibe/core";
import { AgentSession } from "@beevibe/core/services/agent-session";
import type { MemoryAgent } from "@beevibe/core/services/memory";

/** Factory for a per-agent `MemoryAgent`, closing over the shared memory services. */
export type MakeMemoryAgent = (agentId: string) => MemoryAgent;

export interface DispatchDeps {
  agentRepo: AgentRepository;
  sessionRepo: SessionRepository;
  sessionEventRepo: SessionEventRepository;
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
 * Phase 4 dispatcher: takes an already-claimed session row (status='running'
 * already promoted by `claimNextForServerFallback`). The session row carries
 * all the dispatch context — agent_id, intent, prior_session_id — set by
 * dispatchService. AgentSession.run reuses that row instead of inserting a
 * new one.
 */
export type TaskDispatcher = (
  session: Session,
  agent: Agent,
  workspace: Workspace,
  abortSignal: AbortSignal,
) => Promise<Session>;

export function createTaskDispatcher(deps: DispatchDeps): TaskDispatcher {
  return async (session, agent, workspace, abortSignal) => {
    const runtime = deps.runtimeRegistry[agent.runtime_config.type];
    if (!runtime) {
      throw new Error(`Unsupported runtime: ${agent.runtime_config.type}`);
    }

    const memoryAgent = deps.makeMemoryAgent(agent.id);
    const agentSession = new AgentSession({
      agentRepo: deps.agentRepo,
      sessionRepo: deps.sessionRepo,
      sessionEventRepo: deps.sessionEventRepo,
      runtime,
      memoryAgent,
      onSessionComplete: deps.onSessionComplete,
    });

    return agentSession.run({
      agentId: agent.id,
      sessionId: session.id,
      taskId: session.task_id,
      type: session.type,
      intent: session.intent,
      workspace,
      priorSessionId: session.prior_session_id,
      abortSignal,
    });
  };
}
