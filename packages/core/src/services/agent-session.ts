import type { ResolutionProposal } from "../domain/escalation.js";
import type { Session, SessionEventKind, SessionType } from "../domain/session.js";
import { sessionEventId, sessionId as newSessionId } from "../domain/ids.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type {
  AgentRuntime,
  RuntimeResult,
  RuntimeStep,
  Workspace,
} from "../ports/runtime.js";
import type { SessionEventRepository } from "../ports/session-event-repo.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type { MemoryAgent } from "./memory/memory-agent.js";
import { composeIntent, composeSystemPromptAppend } from "./spawn-prep.js";

export {
  BEEVIBE_LIFECYCLE_REMINDER_TASK,
  BEEVIBE_LIFECYCLE_REMINDER_CHAT,
  BEEVIBE_MEMORY_REMINDER,
  CHAT_DIRECTIVES,
  ONBOARDING_DIRECTIVES,
  composeIntent,
  composeSystemPromptAppend,
  teamAgentRoutingDirective,
} from "./spawn-prep.js";

export interface AgentSessionDeps {
  agentRepo: AgentRepository;
  sessionRepo: SessionRepository;
  runtime: AgentRuntime;
  memoryAgent: MemoryAgent;
  /**
   * Transcript persistence. Every `RuntimeStep` is appended to `session_event`
   * so the session detail page can replay the agent's tool calls. Writes
   * are best-effort (fire-and-forget; failures only log) but the dep
   * itself is required so all composition roots wire it consistently.
   *
   * Backpressure note: append() is fire-and-forget — if Postgres is briefly
   * unavailable, the step is lost from the persisted transcript but the LLM
   * still progresses. Tracked by a per-process counter (currently logged
   * via console.warn; promote to Prometheus later).
   */
  sessionEventRepo: SessionEventRepository;
  /**
   * Optional fire-and-forget hook fired once the terminal session row is
   * written. Wired by composition roots — the executor uses it to call
   * `postDispatchCheck` (M6.5: parent rollup + leaf retry-once on missing
   * update_progress). Hook errors are caught and logged; they cannot affect
   * the returned session.
   */
  onSessionComplete?: (session: Session) => Promise<void>;
}

export interface AgentSessionRunInput {
  agentId: string;
  intent: string;
  workspace: Workspace;
  /** Task this session is working on. Required for `type="task"` sessions. */
  taskId?: string;
  /** Session kind. Defaults to "task" when taskId is set, else "chat". */
  type?: SessionType;
  /**
   * Optional pre-generated session id. If provided, AgentSession uses it
   * instead of minting a new one. Used by MeshServer (M6.4) which needs to
   * stamp the counterparty's session id on the negotiation row BEFORE the
   * CLI subprocess spawns (so escalation flows can reference it).
   */
  sessionId?: string;
  /** Resume-chain pointer. Used to set `--resume <cli_session_id>` on the CLI. */
  priorSessionId?: string;
  /** Caller-controlled cancellation. */
  abortSignal?: AbortSignal;
  /** Step-by-step notifier for live UIs. */
  onStep?: (step: RuntimeStep) => void;
  /**
   * Skip the `onSessionComplete` hook for this run. Used by
   * `postDispatchCheck`'s retry path to break the otherwise-recursive call
   * (retry → hook → another postDispatchCheck → another retry → …).
   */
  skipOnComplete?: boolean;
  /**
   * Extra system-prompt content appended after the agent's baseline
   * system_prompt_addition + memory briefing. Used to inject per-call
   * directives (room conventions, chat-mode rules, etc.) without
   * mutating the agent's persistent persona.
   */
  extraSystemPromptAppend?: string;
  /**
   * Stamp this session as belonging to a Room — events fan out via SSE
   * to every room member rather than just the agent's owner, and
   * mesh-spawned children inherit the same room_id.
   */
  roomId?: string;
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

    // 2. Session row. Three call patterns:
    //   - sessionId unset            → mint new id, INSERT (legacy mesh / chat path)
    //   - sessionId set, no row yet  → use that id, INSERT (mesh round-1 pre-id)
    //   - sessionId set, row exists  → reuse the row (post-Phase-4 executor
    //     claim path: dispatchService already inserted at status='pending'
    //     and the worker just promoted it to 'running' via claimNext*)
    const sid = input.sessionId ?? newSessionId();
    const existing = input.sessionId
      ? await this.deps.sessionRepo.findById(input.sessionId)
      : undefined;
    if (existing) {
      // Stamp workspace_path now that the worker has provisioned a local
      // sandbox; the rest of the row was set by dispatchService.
      await this.deps.sessionRepo.update(sid, {
        workspace_path: input.workspace.path,
      });
    } else {
      await this.deps.sessionRepo.create({
        id: sid,
        agent_id: input.agentId,
        task_id: input.taskId,
        prior_session_id: input.priorSessionId,
        type: input.type ?? (input.taskId ? "task" : "chat"),
        intent: input.intent,
        // Inline mesh / chat paths spawn the CLI immediately, so this row
        // skips the 'pending' state entirely. Required now that the DB
        // default is 'pending' (every insert is explicit per Phase 4).
        status: "running",
        workspace_path: input.workspace.path,
        ...(input.roomId ? { room_id: input.roomId } : {}),
        started_at: new Date(),
      });
    }

    // 3. Resume lookup + briefing
    const priorCliSessionId = input.priorSessionId
      ? (await this.deps.sessionRepo.findById(input.priorSessionId))?.cli_session_id
      : undefined;
    const briefing = await this.deps.memoryAgent.prepareBriefing(input.intent);
    // Persist the structured snapshot so the session detail page can render
    // it without re-running the briefing pipeline. Best-effort; an audit
    // failure shouldn't fail session start.
    try {
      await this.deps.sessionRepo.update(sid, { briefing: briefing.snapshot });
    } catch (err) {
      console.error(
        `[AgentSession] failed to persist briefing for ${sid}:`,
        (err as Error).message,
      );
    }
    const system_prompt_append = composeSystemPromptAppend(
      agent.runtime_config.system_prompt_addition,
      briefing.systemPromptAppend,
      input.extraSystemPromptAppend ? { extra: input.extraSystemPromptAppend } : {},
    );
    const intent = composeIntent(input.intent, briefing.userMessagePrefix);

    // Tee onStep into session_event; failures only log so the LLM tail
    // never blocks on transcript persistence.
    const eventRepo = this.deps.sessionEventRepo;
    const appendEvent = (
      kind: SessionEventKind,
      content: string,
      tool_name?: string,
    ): void => {
      void eventRepo
        .append({ id: sessionEventId(), session_id: sid, kind, content, tool_name })
        .catch((err) =>
          console.warn(
            `[AgentSession] session_event ${kind} dropped for ${sid}:`,
            (err as Error).message,
          ),
        );
    };
    const callerOnStep = input.onStep;
    const onStep = (step: RuntimeStep): void => {
      appendEvent(step.kind, step.description, step.tool);
      callerOnStep?.(step);
    };

    // 4. Execute
    let result: RuntimeResult;
    try {
      result = await this.deps.runtime.execute({
        intent,
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
        onStep,
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
      const failedSession = await this.deps.sessionRepo.update(sid, {
        status: "failed",
        error: (err as Error).message,
        completed_at: new Date(),
      });
      // Fire onSessionComplete on the in-catch failure path too. Without
      // this, exceptions thrown out of `executor.execute` (spawn errors,
      // CLI crashes) update the row to status=failed but skip the hook
      // that the graceful failure path on line ~272 fires — leaving mesh
      // resolvers blocked until their 5-min timeout. The hook is
      // fire-and-forget; we still rethrow so the dispatcher sees the
      // original error and can mark the daemon's claim as failed.
      if (!input.skipOnComplete) {
        void this.deps.onSessionComplete?.(failedSession).catch((hookErr) =>
          console.error(
            "[AgentSession] onSessionComplete (catch path) failed:",
            (hookErr as Error).message,
          ),
        );
      }
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

    // Final summary covers replies with zero tool calls (e.g. short chat).
    if (result.output) appendEvent("summary", result.output);

    // 6. Fire-and-forget post-session memory work.
    void this.deps.memoryAgent.onTaskComplete(sid).catch((err) =>
      console.error(
        "[AgentSession] onTaskComplete failed:",
        (err as Error).message,
      ),
    );

    // 7. M6.5 hook for post-dispatch logic (parent rollup, leaf retry).
    // Fire-and-forget; never blocks the caller's promise. Suppressed for the
    // retry path (skipOnComplete) so the retry's own terminal write doesn't
    // recursively re-trigger postDispatchCheck.
    if (!input.skipOnComplete) {
      void this.deps.onSessionComplete?.(finalSession).catch((err) =>
        console.error(
          "[AgentSession] onSessionComplete failed:",
          (err as Error).message,
        ),
      );
    }

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
  | {
      /**
       * Re-dispatched after an unexpected exit (CLI subprocess died,
       * agent forgot update_progress and was nudged). When set,
       * `prior_session_id` pins runtime_id to the prior session's
       * machine so resume reads `.jsonl` from the right disk.
       */
      kind: "crash_recovery";
      prior_session_id?: string;
    }
  | {
      /**
       * Multi-turn chat continuation. Carries the prior session so
       * dispatchService pins runtime_id (resume reads `.jsonl` from the
       * pinned daemon's local disk) and the daemon's spawn passes
       * `--resume <prior.cli_session_id>`. Unlike revision/post_escalation,
       * no narrative `<context>` block is added — the chat user message
       * IS the next turn's intent.
       */
      kind: "chat_continuation";
      prior_session_id: string;
    }
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

    case "chat_continuation":
      // Chat doesn't use buildIntent — the user's message is the intent
      // verbatim. Included here to keep the switch exhaustive.
      return taskAnchor;

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
