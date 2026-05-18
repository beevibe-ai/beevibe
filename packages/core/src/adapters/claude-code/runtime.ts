import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeHealth,
  RuntimeResult,
  Workspace,
} from "../../ports/runtime.js";
import { runCliProcess } from "./spawn.js";
import {
  extractStepEvents,
  parseClaudeMessages,
  parseStreamJsonLine,
  type StreamJsonMessage,
} from "./stream-json.js";

/**
 * Claude Code CLI subprocess runtime.
 *
 * Spawns the `claude` binary with the agent's sandbox as cwd, streams
 * `--output-format stream-json`, derives the `--mcp-config` path from the
 * workspace, and maps the result to RuntimeResult.
 *
 * Does not manage MCP config files, workspaces, git, or persistence.
 * Stateless; no cleanup required.
 */
export interface ClaudeCodeRuntimeConfig {
  /** Override CLI command (defaults to "claude" on PATH). */
  command?: string;
  /** Claude model id. Omit to use the CLI's default. */
  model?: string;
  /** Hard cap on conversation turns per session. Omit for CLI default. */
  maxTurns?: number;
}

/**
 * Env vars the Claude CLI inspects to detect being launched from another
 * Claude session (and refuse to start). We strip them because the executor
 * itself may be running inside Claude Code during development.
 */
const NESTING_GUARD_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION",
  "CLAUDE_CODE_PARENT_SESSION",
] as const;

/**
 * Anthropic auth env vars stripped from the spawned CLI subprocess so it
 * authenticates via its own `~/.claude/` credentials (subscription
 * billing when the user has run `claude login`). Without this, the
 * executor's own `ANTHROPIC_API_KEY` (used by FactPromoter / FactStore
 * for their server-side LLM calls) leaks into the subprocess and forces
 * API-key billing — which silently overrides any subscription auth the
 * user had configured.
 *
 * Per-agent billing-mode opt-in (some agents on API key, others on
 * subscription) is tracked separately for a follow-up.
 */
const ANTHROPIC_AUTH_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly type = "claude";

  constructor(private config: ClaudeCodeRuntimeConfig = {}) {}

  async execute(context: RuntimeContext): Promise<RuntimeResult> {
    const cwd = context.workspace.path;
    const mcpConfigPath = join(cwd, "mcp-config.json");

    const args = [
      "--print",
      "-",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--strict-mcp-config",
      "--mcp-config",
      mcpConfigPath,
    ];
    const model = context.model ?? this.config.model;
    if (model) args.push("--model", model);
    const maxTurns = context.max_turns ?? this.config.maxTurns;
    if (maxTurns) args.push("--max-turns", String(maxTurns));
    if (context.resume_session_id) args.push("--resume", context.resume_session_id);
    if (context.system_prompt_append.length > 0) {
      args.push("--append-system-prompt", context.system_prompt_append);
    }

    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of NESTING_GUARD_VARS) delete env[key];
    for (const key of ANTHROPIC_AUTH_VARS) delete env[key];
    if (context.env) Object.assign(env, context.env);

    // Parse messages incrementally during streaming so we don't re-parse
    // the entire stdout after close. A line buffer handles chunk boundaries
    // (a single JSON message can arrive split across multiple chunks).
    const messages: StreamJsonMessage[] = [];
    let pending = "";
    const handleLine = (line: string): void => {
      const msg = parseStreamJsonLine(line);
      if (!msg) return;
      messages.push(msg);
      if (context.onStep) {
        for (const step of extractStepEvents(msg)) {
          context.onStep(step);
        }
      }
    };

    const result = await runCliProcess({
      command: this.config.command ?? "claude",
      args,
      cwd,
      env,
      stdin: context.intent,
      abortSignal: context.abort_signal,
      onSpawn: ({ pid, process_group_id }) => {
        context.onSpawn?.({ process_pid: pid, process_group_id });
      },
      onLog: (stream, chunk) => {
        if (stream !== "stdout") return;
        pending += chunk;
        let nl: number;
        while ((nl = pending.indexOf("\n")) !== -1) {
          handleLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
      },
    });

    // Flush any final partial line (stream without trailing \n)
    if (pending) handleLine(pending);

    if (result.truncated) {
      console.warn(
        "[ClaudeCodeRuntime] stdout truncated at 4MB — result parsing may be incomplete",
      );
    }

    if (result.aborted) {
      return {
        status: "cancelled",
        output: "Session cancelled.",
        process_pid: result.pid ?? undefined,
        process_group_id: result.process_group_id ?? undefined,
      };
    }

    const parsed = parseClaudeMessages(messages, result.exitCode);
    // Surface the CLI's stderr tail on failure so operators / users get
    // the actual diagnostic instead of just "CLI exited with code N".
    // Capped at 4KB — most useful info is at the end (final error +
    // stacktrace), so tail-slice rather than head.
    const STDERR_TAIL_BYTES = 4096;
    const stderrTail =
      parsed.status === "failed" && result.stderr
        ? result.stderr.slice(-STDERR_TAIL_BYTES)
        : undefined;
    return {
      ...parsed,
      process_pid: result.pid ?? undefined,
      process_group_id: result.process_group_id ?? undefined,
      exit_code: result.exitCode,
      ...(stderrTail ? { stderr: stderrTail } : {}),
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    try {
      // graceMs: 0 so a broken binary fails fast rather than waiting the
      // default 20s after SIGTERM.
      const result = await runCliProcess({
        command: this.config.command ?? "claude",
        args: ["--version"],
        cwd: tmpdir(),
        timeoutMs: 5_000,
        graceMs: 0,
      });
      return { healthy: result.exitCode === 0 };
    } catch {
      return {
        healthy: false,
        error: `Command not found: ${this.config.command ?? "claude"}`,
      };
    }
  }

  async shutdown(): Promise<void> {
    /* stateless — each session is a separate process */
  }

  /**
   * Claude Code auto-discovers skills from `<cwd>/.claude/skills/` (and
   * `~/.claude/skills/` for user-global). For agent-spawned sessions our
   * cwd IS the workspace, so the workspace-local discovery path is
   * `<workspace>/.claude/skills`.
   */
  skillsDir(workspace: Workspace): string {
    return join(workspace.path, ".claude", "skills");
  }
}
