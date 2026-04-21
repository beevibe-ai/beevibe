import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeHealth,
  RuntimeResult,
} from "../../ports/runtime.js";
import { runCliProcess } from "./spawn.js";
import { extractStepEvent, parseClaudeStreamJson, parseStreamJsonLine } from "./stream-json.js";

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

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly type = "claude-code";

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
    if (this.config.model) args.push("--model", this.config.model);
    if (this.config.maxTurns) args.push("--max-turns", String(this.config.maxTurns));
    if (context.resume_session_id) args.push("--resume", context.resume_session_id);

    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of NESTING_GUARD_VARS) delete env[key];

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
        if (stream !== "stdout" || !context.onStep) return;
        for (const line of chunk.split("\n")) {
          const msg = parseStreamJsonLine(line);
          if (!msg) continue;
          const step = extractStepEvent(msg);
          if (step) context.onStep(step);
        }
      },
    });

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

    const parsed = parseClaudeStreamJson(result.stdout, result.exitCode);
    return {
      ...parsed,
      process_pid: result.pid ?? undefined,
      process_group_id: result.process_group_id ?? undefined,
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
}
