/**
 * Spawn the CLI for a claimed session and stream events back to the
 * api server. The dispatch payload is the contract between
 * /runtime/claim and this module.
 */

import { ClaudeCodeRuntime } from "@beevibe/core/adapters/claude-code";
import type { RuntimeStep, RuntimeResult } from "@beevibe/core";
import type { ApiClient } from "./api-client.js";
import { provisionWorkspace } from "./workspace.js";

export interface DispatchPayload {
  session_id: string;
  agent_id: string;
  agent_api_key: string;
  workspace_subdir: string;
  intent: string;
  system_prompt_append: string;
  resume_session_id?: string;
  model?: string;
  max_turns?: number;
  env: Record<string, string>;
  type: "task" | "mesh_ask" | "mesh_negotiate" | "blocker" | "chat";
  mcp_server_url: string;
}

export interface SpawnDeps {
  api: ApiClient;
  /** Default ClaudeCodeRuntime; tests inject a fake. */
  runtime?: ClaudeCodeRuntime;
}

/**
 * Spawn the CLI for one claimed session. Posts each runtime step to
 * /runtime/events and the terminal state to /runtime/done. Returns when
 * /runtime/done has been ack'd (or has failed; either way the daemon is
 * done with this session).
 */
export async function runDispatch(
  deps: SpawnDeps,
  payload: DispatchPayload,
  abortSignal?: AbortSignal,
): Promise<void> {
  const ws = provisionWorkspace({
    agentId: payload.agent_id,
    agentApiKey: payload.agent_api_key,
    mcpServerUrl: payload.mcp_server_url,
  });

  const runtime = deps.runtime ?? new ClaudeCodeRuntime();

  // Buffer events so the daemon doesn't fire one POST per token. Flushed
  // every BATCH_INTERVAL_MS or when the buffer hits BATCH_MAX. Final
  // flush happens before /runtime/done so the persisted transcript is
  // complete by the time chatResolver fires.
  const buffer: Array<{
    session_id: string;
    kind: RuntimeStep["kind"];
    content: string;
    tool_name?: string;
  }> = [];
  let flushTimer: NodeJS.Timeout | undefined;

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const events = buffer.splice(0);
    try {
      await deps.api.post("/runtime/events", { events });
    } catch (err) {
      console.warn(
        "[daemon/spawner] /runtime/events POST failed; events dropped:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const scheduleFlush = (): void => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush();
    }, 250);
  };

  const onStep = (step: RuntimeStep): void => {
    buffer.push({
      session_id: payload.session_id,
      kind: step.kind,
      content: step.description,
      tool_name: step.tool,
    });
    if (buffer.length >= 16) void flush();
    else scheduleFlush();
  };

  let result: RuntimeResult;
  let runError: Error | undefined;
  try {
    result = await runtime.execute({
      intent: payload.intent,
      workspace: ws,
      system_prompt_append: payload.system_prompt_append,
      model: payload.model,
      max_turns: payload.max_turns,
      env: payload.env,
      resume_session_id: payload.resume_session_id,
      abort_signal: abortSignal,
      onStep,
    });
  } catch (err) {
    runError = err instanceof Error ? err : new Error(String(err));
    // Compose a synthetic terminal result so the /runtime/done POST
    // still fires; otherwise the chat resolver hangs until timeout.
    result = {
      status: "failed",
      output: "",
      cli_session_id: undefined,
      usage: undefined,
    } as unknown as RuntimeResult;
  }

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  await flush();

  const done = {
    session_id: payload.session_id,
    status:
      result.status === "completed"
        ? "succeeded"
        : result.status === "failed"
          ? "failed"
          : "cancelled",
    cli_session_id: result.cli_session_id,
    result_summary: result.output,
    exit_code: result.status === "completed" ? 0 : 1,
    error: runError?.message,
    usage: result.usage,
  };
  try {
    await deps.api.post("/runtime/done", done);
  } catch (err) {
    console.error(
      "[daemon/spawner] /runtime/done POST failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
