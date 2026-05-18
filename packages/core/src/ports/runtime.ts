import type { SessionEventKind, SessionUsage } from "../domain/session.js";

/**
 * Universal agent-execution contract.
 *
 * Every runtime adapter (ClaudeCodeRuntime; future: OpenCode, etc.)
 * implements this shape. The orchestrator delegates to the runtime after
 * assembling context and provisioning the workspace.
 *
 * The runtime does not manage git, state, or persistence. It spawns the CLI,
 * interprets its output, and returns a typed RuntimeResult. All file-system
 * side effects happen inside the provided workspace.
 */
export interface AgentRuntime {
  /** Identifier for this runtime kind (e.g. "claude"). Matches the CLI binary name on PATH. */
  readonly type: string;

  /** Execute a single session end-to-end and return its result. */
  execute(context: RuntimeContext): Promise<RuntimeResult>;

  /** Is the runtime's backing command available? Used by startup probes. */
  healthCheck(): Promise<RuntimeHealth>;

  /** Graceful shutdown — no-op for stateless runtimes. */
  shutdown(): Promise<void>;

  /**
   * Where this runtime's CLI auto-discovers skill files within the workspace
   * (M9.3). For Claude Code: `<workspace>/.claude/skills`. For future
   * runtimes (codex, cursor-agent), each implements its own scan path.
   * `LocalWorkspaceManager.ensureWorkspace` calls this to know where to
   * sync the tier-filtered SKILL.md files.
   */
  skillsDir(workspace: Workspace): string;

  /**
   * Optional runtime-specific workspace provisioning hook. Called after the
   * generic workspace + Claude-compatible mcp-config.json are present and
   * before skills are synced. Runtimes use this for config files that must
   * live in the workspace root, for example OpenCode's `opencode.json`.
   */
  prepareWorkspace?(context: RuntimeWorkspaceContext): Promise<void> | void;
}

/**
 * The agent's sandbox directory. Provisioned by WorkspaceManager before
 * the runtime is invoked; all agent work (clones, worktrees, scratch files)
 * happens inside this path.
 */
export interface Workspace {
  /** Absolute path to the agent's home dir. E.g. "~/.beevibe/workspaces/agent_XXX/". */
  path: string;
}

export interface RuntimeWorkspaceContext {
  workspace: Workspace;
  agentApiKey: string;
  mcpServerUrl: string;
}

/**
 * Everything the runtime needs to execute one session.
 *
 * `workspace` is required: the executor always provisions one before calling
 * the runtime. There is no fallback cwd.
 */
export interface RuntimeContext {
  /** What the agent should do — prompt text (task description, mesh message, etc.). */
  intent: string;

  /** Agent's sandbox. Runtime sets cwd to `workspace.path`. */
  workspace: Workspace;

  /**
   * Per-agent model override. AgentSession passes `agent.runtime_config.model`
   * here so each spawn uses the model configured for that agent (e.g. one
   * executor can serve claude-opus-4-7 agents and claude-haiku-4-5 agents
   * concurrently). Adapter falls back to its constructor config when unset.
   */
  model?: string;

  /**
   * Per-agent turn cap. AgentSession passes `agent.runtime_config.max_turns`
   * here. Adapter falls back to constructor config when unset.
   */
  max_turns?: number;

  /**
   * Content appended to Claude Code's baseline system prompt via
   * `--append-system-prompt`. Required: AgentSession composes this from the
   * agent's `runtime_config.system_prompt_addition` baseline plus the memory
   * briefing (core memory blocks + top-k archival fact retrieval). Pass an
   * empty string only for non-session direct invocations (tests, health
   * checks) where no briefing exists.
   */
  system_prompt_append: string;

  /**
   * Extra env vars to merge into the spawned CLI process env. These are
   * inherited by any stdio MCP servers the CLI spawns (and by any child
   * processes the CLI itself spawns). AgentSession uses this to pass
   * `BEEVIBE_SESSION_ID` + `BEEVIBE_AGENT_ID` to the MCP-side tool handlers
   * so `save_memory(content, fact_type)` can stamp the right session id
   * on the fact without the caller needing to pass it explicitly.
   *
   * Merged on top of the adapter's baseline env (process.env minus the
   * Claude nesting guards); duplicate keys in this map override.
   */
  env?: Record<string, string>;

  /** Signal for cancelling the in-flight session. */
  abort_signal?: AbortSignal;

  /** CLI session to resume (sets --resume for Claude Code). */
  resume_session_id?: string;

  /** Real-time step notifier — fires whenever the runtime observes a tool-use event. */
  onStep?: (step: RuntimeStep) => void;

  /**
   * Fires once immediately after the subprocess spawns with a non-null pid.
   * Consumers persist pid/pgid to the session row for crash-recovery
   * liveness probes. If pid is null (synchronous spawn failure), the
   * callback is not fired — the resolved result carries pid: null.
   */
  onSpawn?: (meta: { process_pid: number; process_group_id: number }) => void;
}

/**
 * A single observable step during execution. Emitted via
 * `RuntimeContext.onStep` for UIs that stream progress.
 *
 * `tool_call` steps are tool invocations (set `tool` and a short
 * `description` of the input); `agent` steps are assistant text chunks
 * (`tool` undefined; `description` carries the text). `tool_result`
 * and `summary` are emitted by post-processing layers (tool results
 * surfaced inline, terminal summary appended after CLI exit).
 */
export interface RuntimeStep {
  kind: SessionEventKind;
  /** Tool name. Set for tool_call (and tool_result when known). */
  tool?: string;
  /** For tool_call: short description of input. For agent: the text. */
  description: string;
  /** ISO-8601 timestamp when the event was observed. */
  timestamp: string;
}

/**
 * Outcome of one runtime execution.
 *
 * Field names align 1:1 with `session` table columns so the executor can
 * persist the result without manual mapping.
 */
export interface RuntimeResult {
  /**
   * - "completed" — process exited 0, output parsed.
   * - "failed" — process exited non-zero or errored mid-stream.
   * - "cancelled" — aborted via `abort_signal`. Distinct from failure so
   *   the executor can set `session.status = 'cancelled'`.
   */
  status: "completed" | "failed" | "cancelled";

  /** Final assistant text surfaced to the user / task result_summary. */
  output: string;

  /** Full human-readable transcript (assistant messages + tool calls + results). */
  transcript?: string;

  /** Token / cost counters — maps to session.usage JSONB. */
  usage?: SessionUsage;

  /** CLI's own session id — maps to session.cli_session_id; lets us --resume later. */
  cli_session_id?: string;

  /** OS pid of the spawned CLI — maps to session.process_pid. */
  process_pid?: number;

  /** Process-group id (for killing the whole tree) — maps to session.process_group_id. */
  process_group_id?: number;

  /**
   * Tail of the CLI's stderr (truncated to ~4KB), populated only when
   * `status === 'failed'`. Lets the daemon surface the real diagnostic
   * to /runtime/done instead of the user staring at a useless
   * "CLI exited with code N". `undefined` on success or cancel.
   */
  stderr?: string;

  /**
   * Raw exit code of the CLI subprocess. Distinct from `status`: a
   * non-zero code maps to `status='failed'`, null (spawn never settled)
   * also maps to failed but tells us something different (ENOENT, fork
   * failed, etc.).
   */
  exit_code?: number | null;
}

/** Result of `healthCheck()`. */
export interface RuntimeHealth {
  healthy: boolean;
  latency_ms?: number;
  error?: string;
}

/**
 * Shared registry type — maps `agent.runtime_config.type` to its runtime
 * instance. Both the executor (M5) and the MCP server (M6) compose an
 * `AgentRuntime` per dispatch by looking up the agent's declared type.
 */
export type RuntimeRegistry = Record<string, AgentRuntime>;
