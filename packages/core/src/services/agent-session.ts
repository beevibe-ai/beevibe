import type { Session, SessionType } from "../domain/session.js";
import { sessionId as newSessionId } from "../domain/ids.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type {
  AgentRuntime,
  RuntimeResult,
  RuntimeStep,
  Workspace,
} from "../ports/runtime.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type { MemoryAgent } from "./memory/memory-agent.js";

export interface AgentSessionDeps {
  agentRepo: AgentRepository;
  sessionRepo: SessionRepository;
  runtime: AgentRuntime;
  memoryAgent: MemoryAgent;
}

export interface AgentSessionRunInput {
  agentId: string;
  intent: string;
  urgency: "low" | "normal" | "high" | "critical";
  workspace: Workspace;
  /** Task this session is working on. Required for `type="task"` sessions. */
  taskId?: string;
  /** Session kind. Defaults to "task" when taskId is set, else "chat". */
  type?: SessionType;
  /** Resume-chain pointer. Used to set `--resume <cli_session_id>` on the CLI. */
  priorSessionId?: string;
  /** Caller-controlled cancellation. */
  abortSignal?: AbortSignal;
  /** Step-by-step notifier for live UIs. */
  onStep?: (step: RuntimeStep) => void;
}

/**
 * Orchestrates one CLI invocation end-to-end:
 *
 * 1. Load the agent (agent.runtime_config.system_prompt_addition is the
 *    baseline for the system prompt).
 * 2. Create the session row (status=running) so the MCP tool handler and
 *    the onSpawn callback both have an id to reference.
 * 3. Compose system_prompt_append = baseline + memory briefing.
 * 4. Execute via AgentRuntime; onSpawn persists pid/pgid to the session row.
 * 5. Persist the terminal state (status, usage, cli_session_id, etc.).
 * 6. Fire-and-forget post-session promotion via MemoryAgent.onTaskComplete.
 */
export class AgentSession {
  constructor(private deps: AgentSessionDeps) {}

  async run(input: AgentSessionRunInput): Promise<Session> {
    // 1. Agent
    const agent = await this.deps.agentRepo.findById(input.agentId);
    if (!agent) throw new Error(`AgentSession: agent not found: ${input.agentId}`);

    // 2. Session row
    const sid = newSessionId();
    const session = await this.deps.sessionRepo.create({
      id: sid,
      agent_id: input.agentId,
      task_id: input.taskId,
      prior_session_id: input.priorSessionId,
      type: input.type ?? (input.taskId ? "task" : "chat"),
      intent: input.intent,
      workspace_path: input.workspace.path,
      started_at: new Date(),
    });

    // 3. Resume lookup + briefing
    const priorCliSessionId = input.priorSessionId
      ? (await this.deps.sessionRepo.findById(input.priorSessionId))?.cli_session_id
      : undefined;
    const briefing = await this.deps.memoryAgent.prepareBriefing(input.intent);
    const baseline = agent.runtime_config.system_prompt_addition ?? "";
    const system_prompt_append = [baseline, briefing]
      .filter((s) => s.length > 0)
      .join("\n\n");

    // 4. Execute
    let result: RuntimeResult;
    try {
      result = await this.deps.runtime.execute({
        intent: input.intent,
        urgency: input.urgency,
        workspace: input.workspace,
        system_prompt_append,
        // Session-scoped env vars — ride on the CLI process env and
        // propagate to any stdio MCP server subprocess. Tool handlers
        // read these to stamp session/agent ids on their writes.
        env: {
          BEEVIBE_SESSION_ID: sid,
          BEEVIBE_AGENT_ID: input.agentId,
        },
        resume_session_id: priorCliSessionId,
        abort_signal: input.abortSignal,
        onStep: input.onStep,
        onSpawn: (meta) => {
          this.deps.sessionRepo
            .update(sid, {
              process_pid: meta.process_pid,
              process_group_id: meta.process_group_id,
            })
            .catch((err) =>
              console.error(
                "[AgentSession] onSpawn persist failed:",
                (err as Error).message,
              ),
            );
        },
      });
    } catch (err) {
      await this.deps.sessionRepo.update(sid, {
        status: "failed",
        error: (err as Error).message,
        completed_at: new Date(),
      });
      throw err;
    }

    // 5. Persist terminal state
    const finalStatus =
      result.status === "completed"
        ? ("succeeded" as const)
        : result.status === "failed"
        ? ("failed" as const)
        : ("cancelled" as const);
    const finalSession = await this.deps.sessionRepo.update(sid, {
      status: finalStatus,
      cli_session_id: result.cli_session_id,
      result_summary: result.output,
      usage: result.usage,
      exit_code: result.status === "completed" ? 0 : 1,
      process_pid: result.process_pid,
      process_group_id: result.process_group_id,
      completed_at: new Date(),
    });

    // 6. Fire-and-forget post-session memory work.
    void this.deps.memoryAgent.onTaskComplete(sid).catch((err) =>
      console.error(
        "[AgentSession] onTaskComplete failed:",
        (err as Error).message,
      ),
    );

    // Intentionally do NOT await session.id  — return updated session row.
    void session;
    return finalSession;
  }
}
