import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentRuntime,
  RuntimeContext,
  RuntimeHealth,
  RuntimeResult,
  RuntimeWorkspaceContext,
  Workspace,
} from "../../ports/runtime.js";
import { MCP_TOOL_TIMEOUT_MS } from "../local-workspace/manager.js";
import {
  cancelledResult,
  cliVersionHealthCheck,
  composePrompt,
  finalizeCliResult,
  runNdjsonCliSession,
} from "../runtime-common.js";
import {
  extractCodexStepEvents,
  parseCodexEventLine,
  parseCodexEvents,
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
        // Match Claude Code's mcp-config.json `timeout` field — see
        // MCP_TOOL_TIMEOUT_MS doc-comment for why. Codex's TOML key is
        // `tool_timeout_sec` (seconds, not ms), so convert. Without
        // this, the asker side gives up before the api's mesh-resolver
        // (5 min) has a chance to fire.
        "-c",
        `mcp_servers.beevibe.tool_timeout_sec=${MCP_TOOL_TIMEOUT_MS / 1000}`,
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

    const { events, result } = await runNdjsonCliSession({
      command: this.config.command ?? "codex",
      args,
      cwd: context.workspace.path,
      env,
      runtimeTag: "CodexRuntime",
      context,
      parseLine: parseCodexEventLine,
      extractSteps: extractCodexStepEvents,
    });

    if (result.aborted) {
      removeIfExists(lastMessagePath);
      return cancelledResult(result);
    }

    const lastMessage = readIfExists(lastMessagePath);
    removeIfExists(lastMessagePath);
    return finalizeCliResult(
      parseCodexEvents(events, result.exitCode, lastMessage),
      result,
    );
  }

  async healthCheck(): Promise<RuntimeHealth> {
    return cliVersionHealthCheck(this.config.command ?? "codex", {
      includeStderrOnFailure: true,
    });
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
