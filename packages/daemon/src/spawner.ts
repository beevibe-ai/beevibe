/**
 * Spawn the CLI for a claimed session and stream events back to the
 * api server. The dispatch payload is the contract between
 * /runtime/claim and this module.
 *
 * Workspace + skills sync run through `LocalWorkspaceManager` from
 * `@beevibe/core` so the daemon's filesystem layout matches the
 * api-side path byte-for-byte (mcp-config.json + tier-filtered
 * `<workspace>/.claude/skills/`).
 */

import {
  createDefaultRuntimeRegistry,
  runtimeMissingError,
} from "@beevibe/core/adapters/runtime-registry";
import type {
  Agent,
  KnownCli,
  RuntimeRegistry,
  RuntimeStep,
  RuntimeResult,
  TerminalSessionStatus,
} from "@beevibe/core";
import type { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import type { ApiClient } from "./api-client.js";

export interface DispatchPayload {
  session_id: string;
  agent_id: string;
  agent_api_key: string;
  agent_hierarchy_level: "ic" | "team" | "org";
  runtime_type: KnownCli;
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
  workspaceManager: LocalWorkspaceManager;
  /** Default registry; tests inject fakes. */
  runtimeRegistry?: RuntimeRegistry;
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
  // LocalWorkspaceManager.ensureWorkspace takes an Agent shape. Build the
  // minimal subset its read paths need (id, api_key, hierarchy_level,
  // runtime_config.type) — the rest is unused server-side too.
  const syntheticAgent = {
    id: payload.agent_id,
    api_key: payload.agent_api_key,
    hierarchy_level: payload.agent_hierarchy_level,
    runtime_config: { type: payload.runtime_type },
  } as unknown as Agent;
  const ws = await deps.workspaceManager.ensureWorkspace({ agent: syntheticAgent });

  // One log line per spawn, same `sess=` token as claimer.ts and the
  // exit line below, so one session id grep'd from a daemon log shows
  // the full lifecycle.
  console.log(
    `[daemon/spawn] sess=${payload.session_id} agent=${payload.agent_id} runtime=${payload.runtime_type} type=${payload.type} cwd=${ws.path}`,
  );

  const registry = deps.runtimeRegistry ?? createDefaultRuntimeRegistry();
  const runtime = registry[payload.runtime_type];
  if (!runtime) {
    throw new Error(runtimeMissingError(payload.runtime_type));
  }

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

  let result: RuntimeResult | undefined;
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
    // Spawn / parse failure — runtime never produced a result. POST
    // /runtime/done with a `failed` status anyway so the chat resolver
    // unblocks instead of waiting out the 90s timeout.
    runError = err instanceof Error ? err : new Error(String(err));
  }

  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  await flush();

  const status: TerminalSessionStatus = runError
    ? "failed"
    : result?.status === "completed"
      ? "succeeded"
      : result?.status === "cancelled"
        ? "cancelled"
        : "failed";

  // Build the error string from the most informative source available:
  // 1. A spawn-side throw (workspace mkdir, ENOENT on `claude`, …) — runError.
  // 2. The CLI's own stderr tail when it ran but exited non-zero — result.stderr.
  // Plain "CLI exited with code N" is no longer the user's only signal
  // when something goes wrong.
  const errorDetail = runError?.message ?? result?.stderr;

  const done = {
    session_id: payload.session_id,
    status,
    cli_session_id: result?.cli_session_id,
    result_summary: result?.output ?? "",
    // Real exit code when the spawn actually ran; null on the runError
    // path means "spawn never settled" (ENOENT etc.) — the api can use
    // that to distinguish "CLI ran and failed" from "we never got to
    // run it." Previously hardcoded 0/1, which threw away that info.
    exit_code: result?.exit_code ?? null,
    error: errorDetail,
    usage: result?.usage,
  };

  if (status === "succeeded") {
    console.log(`[daemon/spawn] sess=${payload.session_id} exit=0`);
  } else {
    console.error(
      `[daemon/spawn] sess=${payload.session_id} status=${status} exit=${done.exit_code}` +
        (errorDetail ? `\n  error:\n    ${errorDetail.split("\n").join("\n    ")}` : ""),
    );
  }

  try {
    await deps.api.post("/runtime/done", done);
  } catch (err) {
    console.error(
      "[daemon/spawner] /runtime/done POST failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
