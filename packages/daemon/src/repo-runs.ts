/**
 * Daemon-side handler for `type === 'run_repo'` dispatches.
 *
 * Capability Network MVP (#149). Where a normal dispatch spawns a CLI
 * runtime via `runtime.execute()`, a run_repo dispatch hands the work to
 * @beevibe/sandbox's `runRepoAgent`: a fresh Docker sandbox + a child
 * `claude` session with host Bash/Read/Edit/Write denied and only the
 * five `mcp__beevibe-sandbox__*` tools allowed.
 *
 * Transcript events flow through the existing /runtime/events pipeline
 * (one event row per orchestrator TranscriptEvent). Artifacts and the
 * captured recipe ride along with /runtime/done so the api can write
 * work_product rows and update the repo_run record.
 */

import type { SessionEventKind, TerminalSessionStatus } from "@beevibe/core";
import { runRepoAgent, type TranscriptEvent } from "@beevibe/sandbox/orchestrator";
import type { ApiClient } from "./api-client.js";
import { createEventBatcher } from "./event-batcher.js";
import { error, log } from "./logger.js";
import type { DispatchPayload, RunRepoArtifact } from "./spawner.js";

export interface RunRepoDeps {
  api: ApiClient;
}

/** Path to the `claude` CLI for the sandboxed child agent. */
const CLAUDE_BIN = process.env.BEEVIBE_CLAUDE_BIN ?? "claude";

/**
 * Run a single run_repo dispatch end-to-end. Caller (spawner.ts) is
 * responsible for the supervisor lifecycle; this function only owns
 * the orchestrator invocation + the API round-trips for events/done.
 */
export async function runRepoDispatch(
  deps: RunRepoDeps,
  payload: DispatchPayload,
  abortSignal?: AbortSignal,
): Promise<void> {
  const rr = payload.run_repo;
  if (!rr) {
    // Defensive: spawner only routes here when this is set.
    throw new Error("run_repo dispatch missing payload.run_repo");
  }

  log(
    `[daemon/repo-run] sess=${payload.session_id} repo_run=${rr.repo_run_id} repo=${rr.repo_url}`,
  );

  // Same batching as spawner.ts so the live transcript renders smoothly
  // without one POST per event.
  const events = createEventBatcher({
    api: deps.api,
    sessionId: payload.session_id,
    tag: "[daemon/repo-run]",
  });

  // Track the most recent transcript index we've already pushed so we
  // don't re-send earlier events every time on_state fires (the
  // orchestrator passes the full transcript on each callback).
  let pushedUpTo = 0;
  const pushNew = (transcript: TranscriptEvent[]): void => {
    for (let i = pushedUpTo; i < transcript.length; i++) {
      const ev = transcript[i];
      if (!ev) continue;
      events.push({ kind: mapKind(ev.kind), content: ev.text });
    }
    pushedUpTo = transcript.length;
  };

  // Capture install commands and the last invocation so we can report
  // them in /runtime/done. Heuristic: any `sandbox_exec` tool call
  // whose argument starts with pip/apt/git-clone/npm/yarn counts as
  // "install"; the most recent non-install exec is "invocation".
  const installLines: string[] = [];
  let invocation: string | undefined;

  const noteCommandFromToolCall = (text: string): void => {
    // Tool-call transcript lines come through as e.g.
    //   mcp__beevibe-sandbox__sandbox_exec({"cmd":"pip install pdfplumber"})
    const m = text.match(/sandbox_exec\(\{?"?cmd"?:?\s*"([^"]+)"/);
    if (!m) return;
    const cmd = m[1] ?? "";
    if (!cmd) return;
    if (isInstallCommand(cmd)) installLines.push(cmd);
    else invocation = cmd;
  };

  const result = await runRepoAgent({
    run_id: rr.repo_run_id,
    repo_url: rr.repo_url,
    goal: rr.goal,
    input_url: rr.input_url,
    input_filename: rr.input_filename,
    claude_bin: CLAUDE_BIN,
    max_runtime_seconds: (rr.limits?.wall_clock_minutes ?? 20) * 60,
    on_state: (s) => {
      // Read the watermark before pushNew moves it — the tool-call scan
      // below must cover exactly the entries this callback added, or
      // every install command is re-recorded on each subsequent state.
      const scanFrom = pushedUpTo;
      pushNew(s.transcript);
      // Walk new tool-call events to capture install/invocation hints.
      for (let i = scanFrom; i < s.transcript.length; i++) {
        const ev = s.transcript[i];
        if (ev?.kind === "tool_call") noteCommandFromToolCall(ev.text);
      }
      if (abortSignal?.aborted) {
        // The orchestrator doesn't accept an abort signal yet; this is a
        // best-effort note in the transcript. Hard cancellation lands
        // when the child claude exit propagates.
        events.push({ kind: "summary", content: "[run cancelled by user]" });
        void events.flush();
      }
    },
  });

  await events.close();

  const status: TerminalSessionStatus =
    result.status === "succeeded"
      ? "succeeded"
      : result.status === "blocked"
        ? "failed"
        : result.status === "failed"
          ? "failed"
          : "failed";

  const artifacts: RunRepoArtifact[] = result.artifacts.map((a) => ({
    filename: a.filename,
    title: a.title,
    size_bytes: a.size_bytes,
    host_path: a.host_path,
    sandbox_path: a.sandbox_path,
  }));

  const done = {
    session_id: payload.session_id,
    status,
    result_summary:
      result.status === "succeeded"
        ? `Exported ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}.`
        : result.error ?? "Run did not produce an artifact.",
    error: result.error,
    run_repo: {
      repo_run_id: rr.repo_run_id,
      install_log: installLines.length ? installLines.join("\n") : undefined,
      invocation,
      artifacts,
    },
  };

  if (status === "succeeded") {
    log(
      `[daemon/repo-run] sess=${payload.session_id} succeeded artifacts=${artifacts.length}`,
    );
  } else {
    error(
      `[daemon/repo-run] sess=${payload.session_id} status=${status}` +
        (result.error ? `\n  error:\n    ${result.error.split("\n").join("\n    ")}` : ""),
    );
  }

  try {
    await deps.api.post("/runtime/done", done);
  } catch (err) {
    error(
      "[daemon/repo-run] /runtime/done POST failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Map a sandbox orchestrator TranscriptEvent.kind to a Beevibe
 * SessionEventKind. The orchestrator has 'log' and 'error' which the
 * session_event schema doesn't recognize directly — fold them into
 * 'summary' and 'tool_result' respectively so existing readers still
 * understand them.
 */
function mapKind(kind: TranscriptEvent["kind"]): SessionEventKind {
  switch (kind) {
    case "agent":
      return "agent";
    case "tool_call":
      return "tool_call";
    case "log":
      return "summary";
    case "error":
      return "tool_result";
  }
}

function isInstallCommand(cmd: string): boolean {
  // Match the package-manager invocations the orchestrator's child agent
  // is most likely to run when setting up an external repo.
  return /^(pip\s|pip3\s|apt-get\s|apt\s|brew\s|npm\s+(install|i)|yarn\s+(add|install)|pnpm\s+(add|install)|git\s+clone)/.test(
    cmd.trim(),
  );
}
