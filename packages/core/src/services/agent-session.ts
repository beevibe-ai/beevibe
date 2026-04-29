import type { ResolutionProposal } from "../domain/escalation.js";
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
        workspace: input.workspace,
        system_prompt_append,
        // Per-agent runtime config flows here. ClaudeCodeRuntime reads these
        // on the execute() call with constructor fallback, so one executor
        // process can serve agents configured for different models.
        model: agent.runtime_config.model,
        max_turns: agent.runtime_config.max_turns,
        // Session-scoped env — inherited by stdio MCP server subprocesses.
        // Agent identity rides on the bv_ OAuth token in the MCP config,
        // not here (would risk divergence).
        env: { BEEVIBE_SESSION_ID: sid },
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

// ── ResumeReason + buildIntent (added in M6.3, wired to dispatch in M6.5) ──

/**
 * The reason a session is being spawned, with all per-reason context the
 * intent prompt needs. Set by composition roots (executor's dispatch.ts and
 * api's EscalationService.resolve in M6.4) and consumed by `buildIntent`.
 *
 * The dispatch path (M6.5) reads `task.next_dispatch_context` (a JSONB
 * column) for the explicit-context kinds; `fresh` and `crash_recovery` are
 * inferred from session-row state.
 */
export type ResumeReason =
  | { kind: "fresh" }
  | { kind: "crash_recovery" }
  | {
      kind: "revision";
      feedback: string;
      source: "human" | "parent_agent";
      from_status: "review" | "needs_revision" | "blocked";
      reviser_agent_id?: string;
      prior_session_id?: string;
    }
  | {
      kind: "post_escalation";
      role: "initiator" | "counterparty";
      resolution: ResolutionProposal;
      notes?: string;
      prior_session_id?: string;
    };

/**
 * The minimal Task fields buildIntent needs. Avoids importing the full Task
 * type to keep this helper portable and the dependency graph narrow.
 */
export interface IntentTask {
  id: string;
  title: string;
  description?: string;
}

/**
 * Compose the stdin (user-message) payload for a CLI invocation. The
 * system prompt comes from `--append-system-prompt` (briefing + persona);
 * task-specific data lives here so prompt cache stays warm across sessions.
 *
 * For non-`fresh` reasons the agent has the task body via `--resume`
 * conversation history, so we emit a self-closing `<task id="..."/>`
 * anchor (used by tools like `update_progress(task_id, ...)`) plus a
 * scenario-specific `<context type="...">` block. Only `fresh` includes
 * the full title+description.
 */
export function buildIntent(
  task: IntentTask | null,
  reason: ResumeReason,
): string {
  const taskAnchor =
    task === null
      ? ""
      : reason.kind === "fresh"
        ? `<task id="${task.id}">\n${task.title}${task.description ? "\n\n" + task.description : ""}\n</task>`
        : `<task id="${task.id}"/>`;

  switch (reason.kind) {
    case "fresh":
      return taskAnchor;

    case "crash_recovery":
      return `<context type="crash_recovery">Your previous session ended unexpectedly. Pick up where you left off.</context>\n${taskAnchor}`;

    case "revision": {
      const fb = reason.feedback || "(no specific feedback provided)";
      // Two valid combinations enforced by TaskService.reviseTask:
      //   - source='parent_agent' + from_status='blocked' (post-blocker fix)
      //   - source='human'        + from_status='review' or 'needs_revision'
      const preamble =
        reason.source === "parent_agent"
          ? "Your parent agent has resolved the blocker you reported. Their guidance for proceeding:"
          : "A human reviewer requested changes:";
      return `<context type="revision" source="${reason.source}" from="${reason.from_status}">${preamble}\n${fb}\n\nAddress the feedback and re-submit via update_progress.</context>\n${taskAnchor}`;
    }

    case "post_escalation": {
      const notesLine = reason.notes
        ? `\nAdditional guidance: ${reason.notes}`
        : "";
      const roleLine =
        reason.role === "counterparty"
          ? "\nYour peer is continuing their task with this guidance. Update your memory with anything notable, complete any related follow-up, then exit."
          : "\nContinue your task using this resolution.";
      return `<context type="post_escalation" role="${reason.role}">A negotiation about this task was resolved by a human reviewer.\nResolution: ${reason.resolution.title} — ${reason.resolution.description}${notesLine}${roleLine}</context>\n${taskAnchor}`;
    }
  }
}

// Re-export the escalation domain types this helper consumes so consumers
// (executor's dispatch in M6.5, EscalationService in M6.4) can import them
// through the same subpath as buildIntent.
export type { ResolutionProposal, Proposal } from "../domain/escalation.js";
