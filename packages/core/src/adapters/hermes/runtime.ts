import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeHealth,
  RuntimeResult,
  Workspace,
} from "../../ports/runtime.js";
import { runCliProcess } from "../claude-code/spawn.js";

const STDERR_TAIL_BYTES = 4096;
const DEFAULT_TOOLSETS = "browser,web,terminal,skills";

export interface HermesRuntimeConfig {
  /** Override CLI command (defaults to "hermes" on PATH). */
  command?: string;
  /** Hermes model id. Omit to use Hermes's configured default. */
  model?: string;
  /** Optional provider override, e.g. "nous" or "openrouter". */
  provider?: string;
  /** Comma-separated Hermes toolsets. Defaults to browser/web/terminal/skills. */
  toolsets?: string;
}

/**
 * Hermes Agent CLI subprocess runtime.
 *
 * Hermes owns provider auth, Browser Use/CDP configuration, and its own MCP
 * catalog in `~/.hermes`; Beevibe only launches a one-shot `hermes chat`
 * process inside the agent workspace and captures the final answer.
 */
export class HermesRuntime implements AgentRuntime {
  readonly type = "hermes";

  constructor(private config: HermesRuntimeConfig = {}) {}

  async execute(context: RuntimeContext): Promise<RuntimeResult> {
    const args = ["chat", "--quiet", "--source", "beevibe", "--toolsets", toolsetsFor(this.config)];
    const provider = this.config.provider ?? process.env.BEEVIBE_HERMES_PROVIDER;
    if (provider) args.push("--provider", provider);
    const model = context.model ?? this.config.model;
    if (model) args.push("--model", model);
    const maxTurns = context.max_turns;
    if (maxTurns) args.push("--max-turns", String(maxTurns));
    if (context.resume_session_id) args.push("--resume", context.resume_session_id);
    args.push("-q", composePrompt(context));

    const env: Record<string, string | undefined> = { ...process.env };
    if (context.env) Object.assign(env, context.env);

    let pending = "";
    const handleLine = (line: string): void => {
      const text = stripAnsi(line).trim();
      if (!text) return;
      context.onStep?.({
        kind: "agent",
        description: text,
        timestamp: new Date().toISOString(),
      });
    };

    const result = await runCliProcess({
      command: this.config.command ?? "hermes",
      args,
      cwd: context.workspace.path,
      env,
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
    if (pending) handleLine(pending);

    if (result.truncated) {
      console.warn("[HermesRuntime] output truncated at 4MB - result parsing may be incomplete");
    }

    if (result.aborted) {
      return {
        status: "cancelled",
        output: "Session cancelled.",
        process_pid: result.pid ?? undefined,
        process_group_id: result.process_group_id ?? undefined,
      };
    }

    const stdout = stripAnsi(result.stdout).trim();
    const stderr = stripAnsi(result.stderr).trim();
    const ok = result.exitCode === 0;
    return {
      status: ok ? "completed" : "failed",
      output: stdout || stderr || (ok ? "" : "Hermes exited without output."),
      transcript: transcriptFor(stdout, stderr),
      process_pid: result.pid ?? undefined,
      process_group_id: result.process_group_id ?? undefined,
      exit_code: result.exitCode,
      ...(ok || !stderr ? {} : { stderr: stderr.slice(-STDERR_TAIL_BYTES) }),
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    try {
      const result = await runCliProcess({
        command: this.config.command ?? "hermes",
        args: ["--version"],
        cwd: tmpdir(),
        timeoutMs: 5_000,
        graceMs: 0,
      });
      return {
        healthy: result.exitCode === 0,
        error: result.exitCode === 0 ? undefined : stripAnsi(result.stderr).slice(-500),
      };
    } catch {
      return {
        healthy: false,
        error: `Command not found: ${this.config.command ?? "hermes"}`,
      };
    }
  }

  async shutdown(): Promise<void> {
    /* stateless - each session is a separate process */
  }

  skillsDir(workspace: Workspace): string {
    return join(workspace.path, ".hermes", "skills");
  }
}

function composePrompt(context: RuntimeContext): string {
  if (context.system_prompt_append.length === 0) return context.intent;
  return [
    "<beevibe_system_context>",
    context.system_prompt_append,
    "</beevibe_system_context>",
    "",
    context.intent,
  ].join("\n");
}

function toolsetsFor(config: HermesRuntimeConfig): string {
  return config.toolsets ?? process.env.BEEVIBE_HERMES_TOOLSETS ?? DEFAULT_TOOLSETS;
}

function transcriptFor(stdout: string, stderr: string): string | undefined {
  if (!stdout && !stderr) return undefined;
  if (!stderr) return stdout;
  if (!stdout) return stderr;
  return `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
}

export function stripAnsi(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    "",
  );
}
