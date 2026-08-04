/**
 * Spawn the CLI for a claimed session and stream events back to the
 * api server. The dispatch payload is the contract between
 * /runtime/claim and this module — it lives in `@beevibe/core`'s
 * `domain/daemon-protocol.ts` alongside the rest of the /runtime/*
 * wire types, so the api's response type and the daemon's request type
 * are one declaration rather than two copies that can drift apart.
 * Re-exported here because this module's own consumers
 * (`claimer.ts`, `repo-runs.ts`) import it from `./spawner.js`.
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
  DispatchPayload,
  RuntimeRegistry,
  RuntimeStep,
  RuntimeResult,
  TerminalSessionStatus,
} from "@beevibe/core";
import type { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import type { ApiClient } from "./api-client.js";
import { createEventBatcher } from "./event-batcher.js";
import { error, log } from "./logger.js";
import { runRepoDispatch } from "./repo-runs.js";

export type {
  DispatchPayload,
  RunRepoArtifact,
  RunRepoDispatch,
} from "@beevibe/core";

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
  // Capability Network: run_repo dispatches skip the CLI runtime path
  // entirely and hand off to the sandbox orchestrator. No workspace
  // sync needed — the child agent runs inside Docker, not the user's
  // local workspace.
  if (payload.type === "run_repo") {
    await runRepoDispatch({ api: deps.api }, payload, abortSignal);
    return;
  }

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
  log(
    `[daemon/spawn] sess=${payload.session_id} agent=${payload.agent_id} runtime=${payload.runtime_type} type=${payload.type} cwd=${ws.path}`,
  );

  const registry = deps.runtimeRegistry ?? createDefaultRuntimeRegistry();
  const runtime = registry[payload.runtime_type];
  if (!runtime) {
    throw new Error(runtimeMissingError(payload.runtime_type));
  }

  // Buffer events so the daemon doesn't fire one POST per token. Final
  // flush happens before /runtime/done so the persisted transcript is
  // complete by the time chatResolver fires.
  const events = createEventBatcher({
    api: deps.api,
    sessionId: payload.session_id,
    tag: "[daemon/spawner]",
  });

  const onStep = (step: RuntimeStep): void => {
    events.push({
      kind: step.kind,
      content: step.description,
      tool_name: step.tool,
    });
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

  await events.close();

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
    log(`[daemon/spawn] sess=${payload.session_id} exit=0`);
  } else {
    error(
      `[daemon/spawn] sess=${payload.session_id} status=${status} exit=${done.exit_code}` +
        (errorDetail ? `\n  error:\n    ${errorDetail.split("\n").join("\n    ")}` : ""),
    );
  }

  try {
    await deps.api.post("/runtime/done", done);
  } catch (err) {
    error(
      "[daemon/spawner] /runtime/done POST failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
