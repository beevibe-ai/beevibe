import { existsSync, writeFileSync } from "node:fs";
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
  extractOpenCodeStepEvents,
  parseOpenCodeEventLine,
  parseOpenCodeEvents,
  type OpenCodeEvent,
} from "./stream-json.js";

export interface OpenCodeRuntimeConfig {
  /** Override CLI command (defaults to "opencode" on PATH). */
  command?: string;
  /** OpenCode model id in provider/model form. Omit to use OpenCode's default. */
  model?: string;
}

/**
 * OpenCode CLI subprocess runtime.
 *
 * OpenCode is the multi-provider runtime: it delegates provider/model
 * plumbing to OpenCode itself, so Beevibe can support OpenRouter, Ollama,
 * Groq, Cerebras, LM Studio, vLLM, and other OpenAI-compatible endpoints
 * through one CLI adapter.
 *
 * Per-event parsing lives in `./stream-json.ts` against the wrapper shape
 * `emit()` produces in opencode's `run.ts` (`{ type, timestamp, sessionID,
 * ...payload }`). The runtime itself just owns process lifecycle, MCP
 * wiring, and workspace handoff.
 *
 * Provider auth env vars (OPENROUTER_API_KEY, OPENAI_API_KEY, etc.) are
 * intentionally NOT stripped — opencode depends on them to know which
 * provider to route to.
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
      // `--dir` tells opencode which directory to treat as the project
      // root for config discovery (and file ops). Setting subprocess cwd
      // alone is NOT enough — `opencode run` only loads the workspace
      // `opencode.json` (where our MCP server config lives) when --dir
      // points at it explicitly. Without this, opencode runs with zero
      // MCP servers and the agent has no beevibe tools at all.
      "--dir",
      context.workspace.path,
    ];
    const model = context.model ?? this.config.model;
    if (model) args.push("--model", model);
    if (context.resume_session_id) args.push("--session", context.resume_session_id);
    args.push(composePrompt(context));

    const env: Record<string, string | undefined> = { ...process.env };
    if (context.env) Object.assign(env, context.env);

    const events: OpenCodeEvent[] = [];
    let pending = "";
    const handleLine = (line: string): void => {
      const evt = parseOpenCodeEventLine(line);
      if (!evt) return;
      events.push(evt);
      if (!context.onStep) return;
      for (const step of extractOpenCodeStepEvents(evt)) {
        context.onStep(step);
      }
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

    const parsed = parseOpenCodeEvents(events, result.exitCode);
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
