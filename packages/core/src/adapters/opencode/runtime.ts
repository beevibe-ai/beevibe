import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeHealth,
  RuntimeResult,
  RuntimeStep,
  RuntimeWorkspaceContext,
  Workspace,
} from "../../ports/runtime.js";
import { runCliProcess } from "../claude-code/spawn.js";

export interface OpenCodeRuntimeConfig {
  /** Override CLI command (defaults to "opencode" on PATH). */
  command?: string;
  /** OpenCode model id in provider/model form. Omit to use OpenCode's default. */
  model?: string;
}

type JsonRecord = Record<string, unknown>;

/**
 * OpenCode CLI subprocess runtime.
 *
 * OpenCode is the multi-provider runtime: it delegates provider/model
 * plumbing to OpenCode itself, so Beevibe can support OpenRouter, Ollama,
 * Groq, Cerebras, LM Studio, vLLM, and other OpenAI-compatible endpoints
 * through one CLI adapter.
 */
export class OpenCodeRuntime implements AgentRuntime {
  readonly type = "opencode";

  constructor(private config: OpenCodeRuntimeConfig = {}) {}

  async execute(context: RuntimeContext): Promise<RuntimeResult> {
    const args = [
      "run",
      "--format",
      "json",
      "--dangerously-skip-permissions",
    ];
    const model = context.model ?? this.config.model;
    if (model) args.push("--model", model);
    if (context.resume_session_id) args.push("--session", context.resume_session_id);
    args.push(composePrompt(context));

    const env: Record<string, string | undefined> = { ...process.env };
    if (context.env) Object.assign(env, context.env);

    const events: JsonRecord[] = [];
    let pending = "";
    const handleLine = (line: string): void => {
      const evt = parseJsonLine(line);
      if (!evt) return;
      events.push(evt);
      const step = eventToStep(evt);
      if (step) context.onStep?.(step);
    };

    const result = await runCliProcess({
      command: this.config.command ?? "opencode",
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
      console.warn(
        "[OpenCodeRuntime] stdout truncated at 4MB — result parsing may be incomplete",
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

    const parsed = parseOpenCodeEvents(events, result.stdout, result.exitCode);
    // Mirror ClaudeCodeRuntime: pass exit_code through (daemon persists it
    // to session.exit_code; null vs. a real code distinguishes ENOENT-style
    // spawn failures from "CLI ran and exited N"). Surface stderr tail on
    // failure so the daemon's /runtime/done payload has something
    // actionable — without it the user only sees "OpenCode failed."
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
      const result = await runCliProcess({
        command: this.config.command ?? "opencode",
        args: ["--version"],
        cwd: tmpdir(),
        timeoutMs: 5_000,
        graceMs: 0,
      });
      return { healthy: result.exitCode === 0 };
    } catch {
      return {
        healthy: false,
        error: `Command not found: ${this.config.command ?? "opencode"}`,
      };
    }
  }

  async shutdown(): Promise<void> {
    /* stateless — each session is a separate process */
  }

  skillsDir(workspace: Workspace): string {
    return join(workspace.path, ".opencode", "skills");
  }

  prepareWorkspace(context: RuntimeWorkspaceContext): void {
    const configPath = join(context.workspace.path, "opencode.json");
    if (existsSync(configPath)) return;
    writeFileSync(configPath, buildOpenCodeConfig(context.agentApiKey, context.mcpServerUrl), {
      mode: 0o600,
    });
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

export function buildOpenCodeConfig(apiKey: string, mcpServerUrl: string): string {
  return (
    JSON.stringify(
      {
        "$schema": "https://opencode.ai/config.json",
        mcp: {
          beevibe: {
            type: "remote",
            url: mcpServerUrl,
            enabled: true,
            oauth: false,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-Beevibe-Session": "{env:BEEVIBE_SESSION_ID}",
            },
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function parseJsonLine(line: string): JsonRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function eventToStep(evt: JsonRecord): RuntimeStep | undefined {
  const type = String(evt.type ?? evt.event ?? evt.kind ?? "").toLowerCase();
  const tool = pickString(evt, ["tool", "tool_name", "name"]);
  if (type.includes("tool") || tool) {
    return {
      kind: type.includes("result") ? "tool_result" : "tool_call",
      tool,
      description: summarizeTool(evt),
      timestamp: new Date().toISOString(),
    };
  }
  const text = pickText(evt);
  if (text && (type.includes("message") || type.includes("assistant") || type.includes("text"))) {
    return {
      kind: "agent",
      description: text,
      timestamp: new Date().toISOString(),
    };
  }
  return undefined;
}

function parseOpenCodeEvents(
  events: JsonRecord[],
  stdout: string,
  exitCode: number | null,
): Omit<RuntimeResult, "process_pid" | "process_group_id"> {
  const assistantText = events.map(pickText).filter(Boolean).join("\n").trim();
  const final = [...events].reverse().find((evt) => {
    const type = String(evt.type ?? evt.event ?? evt.kind ?? "").toLowerCase();
    return type.includes("result") || type.includes("done") || type.includes("complete");
  });
  const output = (final && pickText(final)) || assistantText || fallbackText(stdout);
  return {
    status: exitCode === 0 ? "completed" : "failed",
    output: output || (exitCode === 0 ? "OpenCode completed." : "OpenCode failed."),
    transcript: stdout || undefined,
    usage: parseUsage(events),
    cli_session_id: parseSessionId(events),
  };
}

function parseUsage(events: JsonRecord[]): RuntimeResult["usage"] {
  for (const evt of [...events].reverse()) {
    const usage = evt.usage;
    if (!isRecord(usage)) continue;
    const input = pickNumber(usage, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
    const output = pickNumber(usage, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
    const cost = pickNumber(usage, ["cost_usd", "costUSD", "cost"]);
    const model = pickString(usage, ["model"]) ?? pickString(evt, ["model"]);
    if (input === undefined && output === undefined && cost === undefined && model === undefined) {
      continue;
    }
    return {
      input_tokens: input ?? 0,
      output_tokens: output ?? 0,
      cache_creation_input_tokens: pickNumber(usage, ["cache_creation_input_tokens"]) ?? 0,
      cache_read_input_tokens: pickNumber(usage, ["cache_read_input_tokens"]) ?? 0,
      cost_usd: cost,
      model,
    };
  }
  const model = [...events].reverse().map((evt) => pickString(evt, ["model"])).find(Boolean);
  return model ? { input_tokens: 0, output_tokens: 0, model } : undefined;
}

function parseSessionId(events: JsonRecord[]): string | undefined {
  for (const evt of [...events].reverse()) {
    const id =
      pickString(evt, ["session_id", "sessionID", "sessionId"]) ??
      (isRecord(evt.session) ? pickString(evt.session, ["id", "session_id"]) : undefined);
    if (id) return id;
  }
  return undefined;
}

function pickText(evt: JsonRecord): string {
  const direct = pickString(evt, ["output", "text", "content", "message"]);
  if (direct) return direct;
  if (isRecord(evt.message)) {
    return pickString(evt.message, ["content", "text"]) ?? "";
  }
  return "";
}

function summarizeTool(evt: JsonRecord): string {
  const input = evt.input ?? evt.arguments ?? evt.args ?? evt.params;
  if (typeof input === "string") return input.slice(0, 300);
  if (isRecord(input)) {
    const path = pickString(input, ["file_path", "path", "file"]);
    const command = pickString(input, ["command", "cmd"]);
    if (path) return path;
    if (command) return command;
    return JSON.stringify(input).slice(0, 300);
  }
  return pickText(evt) || "tool call";
}

function fallbackText(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => {
      const parsed = parseJsonLine(line);
      return parsed ? pickText(parsed) : line;
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function pickString(obj: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function pickNumber(obj: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
