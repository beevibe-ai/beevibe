import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeHealth,
  RuntimeResult,
  RuntimeWorkspaceContext,
  Workspace,
} from "../../ports/runtime.js";
import { runCliProcess } from "../claude-code/spawn.js";
import {
  extractCodexStepEvents,
  parseCodexEventLine,
  parseCodexEvents,
  type CodexEvent,
} from "./stream-json.js";

export interface CodexRuntimeConfig {
  /** Override CLI command (defaults to "codex" on PATH). */
  command?: string;
  /** Codex model id. Omit to use Codex's configured default. */
  model?: string;
}

/**
 * OpenAI auth env vars stripped from the spawned Codex subprocess so it
 * authenticates via its own `~/.codex/` credentials (ChatGPT subscription
 * when the user has run `codex login`). Mirrors `ANTHROPIC_AUTH_VARS` in
 * ClaudeCodeRuntime: without this, an `OPENAI_API_KEY` set in the
 * daemon's shell (or leaked from a stray `.env`) silently overrides
 * the subscription auth the user had configured and forces API-key billing.
 */
const OPENAI_AUTH_VARS = ["OPENAI_API_KEY", "OPENAI_AUTH_TOKEN"] as const;

interface PreparedWorkspace {
  agentApiKey: string;
  mcpServerUrl: string;
}

/**
 * Codex CLI subprocess runtime.
 *
 * Spawns `codex exec --json`, parses the typed event stream documented in
 * `codex-rs/exec/src/exec_events.rs`, and maps the result to RuntimeResult.
 * Per-event step parsing lives in `./stream-json.ts` — the runtime itself
 * just owns process lifecycle, MCP wiring, and workspace handoff.
 *
 * Stateless; no cleanup required beyond removing the per-spawn
 * `--output-last-message` file (codex leaves it behind otherwise).
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
        // Auto-approve every beevibe MCP tool. `--ask-for-approval never`
        // + `--sandbox workspace-write` does NOT bypass codex's MCP
        // approval flow — codex auto-approves MCP only when sandbox is
        // `danger-full-access`. In headless `exec` mode there's no TTY to
        // answer the elicitation, so the prompt resolves to "cancel" and
        // every tool call fails with "user cancelled MCP tool call".
        // Workspace-write keeps filesystem safety; this opens MCP only.
        "-c",
        `mcp_servers.beevibe.default_tools_approval_mode=${tomlString("approve")}`,
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
    for (const key of OPENAI_AUTH_VARS) delete env[key];
    if (context.env) Object.assign(env, context.env);
    if (prepared) env.BEEVIBE_AGENT_API_KEY = prepared.agentApiKey;

    const events: CodexEvent[] = [];
    let pending = "";
    const handleLine = (line: string): void => {
      const evt = parseCodexEventLine(line);
      if (!evt) return;
      events.push(evt);
      if (!context.onStep) return;
      for (const step of extractCodexStepEvents(evt)) {
        context.onStep(step);
      }
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

    if (result.truncated) {
      console.warn(
        "[CodexRuntime] stdout truncated at 4MB — result parsing may be incomplete",
      );
    }

    if (result.aborted) {
      removeIfExists(lastMessagePath);
      return {
        status: "cancelled",
        output: "Session cancelled.",
        process_pid: result.pid ?? undefined,
        process_group_id: result.process_group_id ?? undefined,
      };
    }

    const lastMessage = readIfExists(lastMessagePath);
    removeIfExists(lastMessagePath);
    const parsed = parseCodexEvents(events, result.exitCode, lastMessage);
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

function readIfExists(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function removeIfExists(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Best-effort cleanup; leftover files don't affect correctness.
  }
}
