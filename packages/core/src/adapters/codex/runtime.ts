import { existsSync, readFileSync } from "node:fs";
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

export interface CodexRuntimeConfig {
  /** Override CLI command (defaults to "codex" on PATH). */
  command?: string;
  /** Codex model id. Omit to use Codex's configured default. */
  model?: string;
}

type JsonRecord = Record<string, unknown>;

interface PreparedWorkspace {
  agentApiKey: string;
  mcpServerUrl: string;
}

/**
 * Codex CLI subprocess runtime.
 *
 * This adapter is intentionally small: it proves Beevibe's runtime registry
 * can route sessions to Codex while preserving the existing RuntimeResult /
 * RuntimeStep contract. Codex's own CLI owns tool execution and JSONL event
 * streaming; Beevibe owns workspace provisioning, MCP policy, persistence,
 * and task/session lifecycle.
 */
export class CodexRuntime implements AgentRuntime {
  readonly type = "codex";
  private readonly prepared = new Map<string, PreparedWorkspace>();

  constructor(private config: CodexRuntimeConfig = {}) {}

  async execute(context: RuntimeContext): Promise<RuntimeResult> {
    const prepared = this.prepared.get(context.workspace.path);
    const sid = context.env?.BEEVIBE_SESSION_ID;
    const lastMessagePath = join(
      context.workspace.path,
      `.beevibe-codex-last-message-${Date.now()}.txt`,
    );

    const globalArgs = buildGlobalArgs(context, this.config);
    const execArgs = [
      "--json",
      "--skip-git-repo-check",
      "--output-last-message",
      lastMessagePath,
    ];
    if (prepared && sid) {
      globalArgs.push(
        "-c",
        `mcp_servers.beevibe.url=${tomlString(withBeevibeSession(prepared.mcpServerUrl, sid))}`,
        "-c",
        `mcp_servers.beevibe.bearer_token_env_var=${tomlString("BEEVIBE_AGENT_API_KEY")}`,
      );
    }

    const args = context.resume_session_id
      ? [
          ...globalArgs,
          "exec",
          "resume",
          ...execArgs,
          context.resume_session_id,
          composePrompt(context),
        ]
      : [...globalArgs, "exec", ...execArgs, composePrompt(context)];

    const env: Record<string, string | undefined> = { ...process.env };
    if (context.env) Object.assign(env, context.env);
    if (prepared) env.BEEVIBE_AGENT_API_KEY = prepared.agentApiKey;

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
      command: this.config.command ?? "codex",
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

    if (result.aborted) {
      return {
        status: "cancelled",
        output: "Session cancelled.",
        process_pid: result.pid ?? undefined,
        process_group_id: result.process_group_id ?? undefined,
      };
    }

    const parsed = parseCodexEvents(events, result.stdout, result.exitCode, lastMessagePath);
    return {
      ...parsed,
      process_pid: result.pid ?? undefined,
      process_group_id: result.process_group_id ?? undefined,
      exit_code: result.exitCode,
      stderr: parsed.status === "failed" ? result.stderr.slice(-4_000) : undefined,
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    try {
      const result = await runCliProcess({
        command: this.config.command ?? "codex",
        args: ["--version"],
        cwd: tmpdir(),
        timeoutMs: 5_000,
        graceMs: 0,
      });
      return {
        healthy: result.exitCode === 0,
        error: result.exitCode === 0 ? undefined : result.stderr.slice(-500),
      };
    } catch {
      return {
        healthy: false,
        error: `Command not found: ${this.config.command ?? "codex"}`,
      };
    }
  }

  async shutdown(): Promise<void> {
    /* stateless — each session is a separate process */
  }

  skillsDir(workspace: Workspace): string {
    return join(workspace.path, ".codex", "skills");
  }

  prepareWorkspace(context: RuntimeWorkspaceContext): void {
    this.prepared.set(context.workspace.path, {
      agentApiKey: context.agentApiKey,
      mcpServerUrl: context.mcpServerUrl,
    });
  }
}

function buildGlobalArgs(context: RuntimeContext, config: CodexRuntimeConfig): string[] {
  const args = [
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--cd",
    context.workspace.path,
  ];
  const model = context.model ?? config.model;
  if (model) args.push("--model", model);
  return args;
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

function withBeevibeSession(mcpServerUrl: string, sid: string): string {
  const url = new URL(mcpServerUrl);
  url.searchParams.set("beevibe_session", sid);
  return url.toString();
}

function tomlString(value: string): string {
  return JSON.stringify(value);
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
  const item = isRecord(evt.item) ? evt.item : undefined;
  const tool =
    pickString(evt, ["tool", "tool_name", "name"]) ??
    (item ? pickString(item, ["tool", "tool_name", "name"]) : undefined);
  if (type.includes("tool") || tool) {
    return {
      kind: type.includes("result") || type.includes("completed") ? "tool_result" : "tool_call",
      tool,
      description: summarizeTool(evt),
      timestamp: new Date().toISOString(),
    };
  }
  const text = pickText(evt);
  if (text) {
    return {
      kind: "agent",
      description: text,
      timestamp: new Date().toISOString(),
    };
  }
  return undefined;
}

function parseCodexEvents(
  events: JsonRecord[],
  stdout: string,
  exitCode: number | null,
  lastMessagePath: string,
): Omit<RuntimeResult, "process_pid" | "process_group_id"> {
  const lastMessage = readIfExists(lastMessagePath).trim();
  const assistantText = events.map(pickText).filter(Boolean).join("\n").trim();
  const output = lastMessage || assistantText || fallbackText(stdout);
  return {
    status: exitCode === 0 ? "completed" : "failed",
    output: output || (exitCode === 0 ? "Codex completed." : "Codex failed."),
    transcript: stdout || undefined,
    usage: parseUsage(events),
    cli_session_id: parseSessionId(events),
  };
}

function readIfExists(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function parseUsage(events: JsonRecord[]): RuntimeResult["usage"] {
  for (const evt of [...events].reverse()) {
    const usage = isRecord(evt.usage)
      ? evt.usage
      : isRecord(evt.token_usage)
        ? evt.token_usage
        : undefined;
    if (!usage) continue;
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
  return undefined;
}

function parseSessionId(events: JsonRecord[]): string | undefined {
  for (const evt of [...events].reverse()) {
    const id =
      pickString(evt, ["session_id", "sessionID", "sessionId", "thread_id", "threadId"]) ??
      (isRecord(evt.session) ? pickString(evt.session, ["id", "session_id"]) : undefined) ??
      (isRecord(evt.thread) ? pickString(evt.thread, ["id", "thread_id"]) : undefined);
    if (id) return id;
  }
  return undefined;
}

function pickText(evt: JsonRecord): string {
  const direct = pickString(evt, ["output", "text", "content", "message", "delta"]);
  if (direct) return direct;
  const item = isRecord(evt.item) ? evt.item : undefined;
  if (item) {
    const itemText = pickString(item, ["text", "content", "message"]);
    if (itemText) return itemText;
  }
  if (isRecord(evt.message)) {
    return pickString(evt.message, ["content", "text"]) ?? "";
  }
  return "";
}

function summarizeTool(evt: JsonRecord): string {
  const item = isRecord(evt.item) ? evt.item : undefined;
  const input = evt.input ?? evt.arguments ?? evt.args ?? evt.params ?? item?.input;
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
