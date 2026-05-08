import type { ResolutionProposal } from "../domain/escalation.js";
import type { Session, SessionType } from "../domain/session.js";
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

/**
 * Always-on baseline injected into the system prompt for every agent-
 * spawned task session (M9.5+ empirical fix). Skill DESCRIPTIONS in Claude
 * Code's auto-discovery block are passive selectors — the agent invokes
 * the body only when it recognizes a specific intent-shape match. For
 * trivial tasks ("reply with X") and continuous behaviors ("manage memory
 * actively"), the agent never invokes any skill. Lifecycle + memory
 * management therefore live here, not as skills.
 *
 * BEEVIBE_LIFECYCLE_REMINDER: identity + session lifecycle (always call
 * update_progress before exit; leaf-vs-parent rule).
 *
 * BEEVIBE_MEMORY_REMINDER: Letta-pattern active memory management — the
 * Letta team's empirical finding (echoed by their docs) is that
 * memory-tool descriptions PLUS system-prompt instructions to use them
 * actively are what drives mid-session memory updates. We adopt the same
 * shape: tool descriptions tell the agent WHAT each tool does; this
 * reminder tells the agent WHEN and WHY to invoke them.
 *
 * Cache-stable: identical text for every agent. Adds ~500 tokens combined;
 * once cached (≥4096 token threshold for Opus 4.7), reads at 0.1× rate.
 *
 * Companion skills remain lazy-loaded for scenario-specific deep protocols
 * (mesh negotiation, post-blocker revision, work-product decision tree,
 * git workspace setup, etc.) — those have specific intent-shape triggers
 * the agent recognizes.
 */
const BEEVIBE_LIFECYCLE_REMINDER = `<beevibe_lifecycle>
You are a beevibe agent (BEEVIBE_AGENT_ID env identifies you). Critical
behavioral rules for every task session:

1. Before exiting any task session, you MUST call mcp__beevibe__update_progress
   with task_id (from your intent's <task id="..."/> tag), status, and
   summary. Status: 'done' (succeeded), 'failed' (can't complete; summary
   explains why), or 'blocked' (only if you already called report_blocker).
   Summary: 1-3 sentences including any URLs / wp_* work-product ids the
   human reviewer will need.

2. Without update_progress, the platform fires a wasteful retry session 2s
   after exit. Always call it before ending your turn.

3. Exception: if you delegated work via mcp__beevibe__create_task during
   this session (team/org tier), you are a parent task — DO NOT call
   update_progress(done) yourself. The platform's children-rollup
   auto-completes the parent when all subtasks settle.

4. When you produce a deliverable for the task (PR, written analysis,
   design doc, etc.), record it via mcp__beevibe__create_work_product so
   the human reviewer can find it from the task. ALWAYS call
   mcp__beevibe__list_work_products(task_id) first — if a relevant work
   product already exists for this task (e.g., on a revision session, the
   PR you opened earlier), call mcp__beevibe__update_work_product on it;
   never create a duplicate row. The 'type' arg must be one of:
   pull_request, branch, commit, document, analysis, report, design,
   artifact, preview.

5. For multi-step protocols (mesh negotiation, git workspace setup), the
   relevant beevibe-* skill in .claude/skills/ has the deep guidance —
   invoke via Skill tool when their description matches your situation.
</beevibe_lifecycle>`;

const BEEVIBE_MEMORY_REMINDER = `<beevibe_memory>
You have two persistent memory layers — actively manage both THROUGHOUT
the session, not just at the end. Mid-session memory updates compound
across tasks; deferring them loses information when your conversation
history is gone.

Layer 1 — core memory (small, in-context per session, rendered into your
system prompt at session start as <core_memory>...</core_memory>):
- Edit via mcp__beevibe__update_core_memory(block_name, operation, content,
  old_content?). operation ∈ {append, replace}.
- Common blocks: persona / domain / constraints / learnings.
- Use for STABLE shifts: persona updates ("I now also handle X"),
  long-term constraint changes, durable patterns that should appear in
  every future session's briefing.
- Treat as expensive real estate — every byte is in every future system
  prompt.

Layer 2 — archival memory (vector-indexed, unbounded; the briefing's
top-k hits arrive in your USER prompt as <archival_memory>...</archival_memory>):
- Add via mcp__beevibe__save_memory(content, fact_type). One fact per call.
  fact_type ∈ {belief, pattern, gotcha, preference, decision}.
- Query mid-session via mcp__beevibe__search_context(query) for facts not
  in your briefing's top-k.
- Use for ONE-SHOT learnings: decision rationales, gotchas, surprising
  patterns, niche facts. Cheap; default home.

When to update memory (proactively, mid-session):
- You resolved something tricky → save_memory(rationale, "decision")
- You hit a non-obvious gotcha → save_memory(...., "gotcha")
- You found a pattern that worked → save_memory(..., "pattern")
- A user/teammate stated a preference → save_memory(..., "preference")
- Your role/domain shifted → update_core_memory(persona/constraints, ...)

Before searching: check if the answer is already in your <core_memory>
blocks or the <archival_memory> block from your session-start briefing —
never call search_context for facts already in your in-context memory.

Promotion ladder (archival is the default, core is reserved):
- save_memory writes archival — cheap and forgiving; that's where new
  facts should go.
- update_core_memory edits core — every byte ends up in every future
  session's system prompt. Reserve for facts that have ALREADY surfaced
  across multiple sessions AND belong in every future briefing.
- Default rule when in doubt: save_memory. Promote later if the fact
  keeps recurring.

Staleness — retrieved facts carry saved=YYYY-MM-DD on the <fact> tag
(both in your briefing and in search_context results). If a fact is
months old, treat it as advisory: the world may have moved on. Verify
against current state (read the code, ask, or check the DB) before
relying on it. When you re-confirm an old fact, save_memory a fresh
version with current date so future retrievals get the more recent
write.
</beevibe_memory>`;

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

    // 2. Session row — caller may pre-supply an id (M6.4 mesh path needs to
    // know B's sid before spawn so it can stamp counterparty_session_id on
    // the negotiation row).
    const sid = input.sessionId ?? newSessionId();
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
    // Cache-friendly order: most-stable first.
    //   1. BEEVIBE_LIFECYCLE_REMINDER + BEEVIBE_MEMORY_REMINDER
    //      (cross-agent constants)
    //   2. agent.runtime_config.system_prompt_addition (per-agent baseline)
    //   3. briefing.systemPromptAppend (= core_memory; mostly stable per agent)
    // archival_memory lives separately on `intent` via M9.4's userMessagePrefix.
    const baseline = agent.runtime_config.system_prompt_addition ?? "";
    const system_prompt_append = [
      BEEVIBE_LIFECYCLE_REMINDER,
      BEEVIBE_MEMORY_REMINDER,
      baseline,
      briefing.systemPromptAppend,
    ]
      .filter((s) => s.length > 0)
      .join("\n\n");

    // M9.4: prepend per-session archival memory to the user message
    // (intent), keeping it OUT of the system prompt so the system prompt
    // stays cache-stable across sessions for the same agent. Empty string
    // when there are no facts to surface; skip the prefix entirely in that
    // case to keep the intent unchanged.
    const intent = briefing.userMessagePrefix
      ? `${briefing.userMessagePrefix}\n\n${input.intent}`
      : input.intent;

    // Compose onStep: transcript persistence (fire-and-forget; never
    // blocks the LLM-bound tail) followed by the caller's hook (if any).
    // The kind passes through from the runtime so the SSE pipeline can
    // carry both tool-call streams and assistant text streams to UIs.
    const eventRepo = this.deps.sessionEventRepo;
    const callerOnStep = input.onStep;
    const onStep = (step: RuntimeStep): void => {
      void eventRepo
        .append({
          id: sessionEventId(),
          session_id: sid,
          kind: step.kind,
          content: step.description,
          tool_name: step.tool,
        })
        .catch((err) =>
          console.warn(
            `[AgentSession] session_event append dropped for ${sid}:`,
            (err as Error).message,
          ),
        );
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

    // Terminal `summary` event — gives the detail page the agent's final
    // response even when there were no tool calls (e.g. quick chat replies).
    if (result.output) {
      void eventRepo
        .append({
          id: sessionEventId(),
          session_id: sid,
          kind: "summary",
          content: result.output,
        })
        .catch((err) =>
          console.warn(
            `[AgentSession] session_event summary dropped for ${sid}:`,
            (err as Error).message,
          ),
        );
    }

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
