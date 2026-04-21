import type { SessionUsage } from "../domain/session.js";

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
  /** Identifier for this runtime kind (e.g. "claude-code"). */
  readonly type: string;

  /** Execute a single session end-to-end and return its result. */
  execute(context: RuntimeContext): Promise<RuntimeResult>;

  /** Is the runtime's backing command available? Used by startup probes. */
  healthCheck(): Promise<RuntimeHealth>;

  /** Graceful shutdown — no-op for stateless runtimes. */
  shutdown(): Promise<void>;
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

/**
 * Everything the runtime needs to execute one session.
 *
 * `workspace` is required: the executor always provisions one before calling
 * the runtime. There is no fallback cwd.
 */
export interface RuntimeContext {
  /** What the agent should do — prompt text (task description, mesh message, etc.). */
  intent: string;

  /** Urgency hint passed through to the runtime (may influence scheduling). */
  urgency: "low" | "normal" | "high" | "critical";

  /** Agent's sandbox. Runtime sets cwd to `workspace.path`. */
  workspace: Workspace;

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
 * A single tool-invocation observed during execution. Emitted via
 * `RuntimeContext.onStep` for UIs that stream progress.
 */
export interface RuntimeStep {
  /** Tool name (e.g. "Read", "Bash", "mcp__platform__search_context"). */
  tool: string;
  /** Short human-readable description (path, command, query, etc.). */
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
}

/** Result of `healthCheck()`. */
export interface RuntimeHealth {
  healthy: boolean;
  latency_ms?: number;
  error?: string;
}
