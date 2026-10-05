import { tmpdir } from "node:os";
import type {
  RuntimeContext,
  RuntimeHealth,
  RuntimeResult,
  RuntimeStep,
} from "../ports/runtime.js";
import {
  type CliProcessOptions,
  type CliProcessResult,
  runCliProcess,
} from "./claude-code/spawn.js";

/**
 * Shared helpers for the CLI-subprocess runtimes (claude-code, codex,
 * opencode). Each of those adapters spawns a `claude`/`codex`/`opencode`
 * process, reads an NDJSON event stream off stdout, and maps the result to a
 * `RuntimeResult`. The pieces that were byte-for-byte identical across the
 * adapters live here so there is a single source of truth; the provider-
 * specific event schemas and their `switch`-based parsers stay in each
 * adapter's own `stream-json.ts` (they are genuinely different and must).
 */

/**
 * Parse one line of an NDJSON event stream. Returns `null` for blank lines,
 * non-object lines, or malformed JSON — the runtimes tolerate interleaved
 * non-JSON log noise on stdout, so an unparseable line is skipped, not fatal.
 *
 * The `T` cast is unchecked: callers pass their provider-specific event type
 * and the downstream `extract*StepEvents` / `parse*Events` functions do the
 * real shape-narrowing.
 */
export function parseNdjsonLine<T>(line: string): T | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

/**
 * Field-priority probe used to turn a tool's structured input into a short
 * human-readable label ("Read packages/foo.ts" not "{file_path: ...}") for
 * the live transcript. Shared by the codex and opencode adapters, which see
 * the same tool-input field names. (Claude Code's `describeToolInput` is a
 * richer superset — extra `name`/`persona` and single-key branches — and
 * intentionally keeps its own implementation.)
 */
export const PREFERRED_TOOL_INPUT_FIELDS = [
  "file_path",
  "path",
  "command",
  "cmd",
  "query",
  "pattern",
  "url",
  "intent",
] as const;

/**
 * Pull the most informative string field out of a tool-call input payload,
 * truncated to 200 chars. Falls back to the raw JSON when no preferred field
 * is present. `fields` defaults to {@link PREFERRED_TOOL_INPUT_FIELDS}.
 */
export function describeToolInput(
  input: unknown,
  fields: readonly string[] = PREFERRED_TOOL_INPUT_FIELDS,
): string {
  if (typeof input === "string") return input.slice(0, 200);
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const obj = input as Record<string, unknown>;
  for (const key of fields) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v.slice(0, 200);
  }
  return JSON.stringify(input).slice(0, 200);
}

/**
 * Compose the prompt passed to a CLI runtime on argv: the raw intent when
 * there is no system-prompt append, otherwise the append wrapped in a
 * `<beevibe_system_context>` block ahead of the intent. This wire format is a
 * cross-provider contract (transcript summarizers key off the tags), so the
 * codex and opencode adapters share this single definition rather than each
 * carrying a copy that could silently drift. (Claude Code feeds the append
 * via its `--append-system-prompt` flag and pipes the intent over stdin, so
 * it does not use this.)
 */
export function composePrompt(context: RuntimeContext): string {
  if (context.system_prompt_append.length === 0) return context.intent;
  return [
    "<beevibe_system_context>",
    context.system_prompt_append,
    "</beevibe_system_context>",
    "",
    context.intent,
  ].join("\n");
}

/**
 * Standard `<cli> --version` health check shared by every CLI runtime.
 * `graceMs: 0` so a broken binary fails fast rather than waiting the default
 * grace period after SIGTERM. A thrown spawn error (binary not on PATH) maps
 * to `Command not found: <command>`.
 *
 * When `includeStderrOnFailure` is set, the stderr tail is surfaced on the
 * unhealthy branch (codex opts into this for a more actionable error); the
 * other runtimes leave `error` undefined on a clean non-zero exit.
 */
export async function cliVersionHealthCheck(
  command: string,
  opts: { includeStderrOnFailure?: boolean } = {},
): Promise<RuntimeHealth> {
  try {
    const result = await runCliProcess({
      command,
      args: ["--version"],
      cwd: tmpdir(),
      timeoutMs: 5_000,
      graceMs: 0,
    });
    if (result.exitCode === 0) return { healthy: true };
    return opts.includeStderrOnFailure
      ? { healthy: false, error: result.stderr.slice(-500) }
      : { healthy: false };
  } catch {
    return { healthy: false, error: `Command not found: ${command}` };
  }
}

/**
 * Build the `onLog` handler that turns raw stdout chunks into whole lines.
 *
 * Every CLI runtime reads an NDJSON stream off stdout, but chunk boundaries
 * are arbitrary — a chunk can split a JSON object mid-line, or carry several
 * lines at once. This buffers the remainder between chunks and invokes
 * `handleLine` once per complete line. stderr is ignored (it is captured
 * wholesale by `runCliProcess` and only read on failure).
 *
 * The returned `flush` emits any trailing partial line, for streams that end
 * without a final newline. Callers must invoke it after the process settles.
 */
export function createStdoutLineReader(handleLine: (line: string) => void): {
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
  flush: () => void;
} {
  let pending = "";
  return {
    onLog: (stream, chunk) => {
      if (stream !== "stdout") return;
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf("\n")) !== -1) {
        handleLine(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
    },
    flush: () => {
      if (pending) {
        const last = pending;
        pending = "";
        handleLine(last);
      }
    },
  };
}

/**
 * Warn when the CLI's stdout hit the capture cap. Past that point the event
 * stream is missing lines, so a parsed result may be incomplete — worth a log
 * line, but not fatal: a truncated transcript still beats no result at all.
 */
export function warnIfTruncated(runtimeTag: string, result: CliProcessResult): void {
  if (!result.truncated) return;
  console.warn(`[${runtimeTag}] stdout truncated at 4MB — result parsing may be incomplete`);
}

/**
 * The `RuntimeResult` for a session the caller aborted via `abort_signal`.
 * Deliberately distinct from a failure so the executor marks the session
 * `cancelled` rather than surfacing it as an error to the user.
 */
export function cancelledResult(result: CliProcessResult): RuntimeResult {
  return {
    status: "cancelled",
    output: "Session cancelled.",
    process_pid: result.pid ?? undefined,
    process_group_id: result.process_group_id ?? undefined,
  };
}

/**
 * Merge the process-level metadata into a parsed `RuntimeResult`.
 *
 * Surfaces the CLI's stderr tail on failure so operators / users get the
 * actual diagnostic instead of just "CLI exited with code N". Capped at 4KB —
 * the most useful info (final error + stacktrace) is at the end, so this
 * tail-slices rather than head-slices.
 */
const STDERR_TAIL_BYTES = 4096;

export function finalizeCliResult(
  parsed: RuntimeResult,
  result: CliProcessResult,
): RuntimeResult {
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

/**
 * Run one CLI session end to end: spawn the process, parse its NDJSON event
 * stream line by line while it runs, forward the derived `RuntimeStep`s to
 * `context.onStep`, then map the collected events to a `RuntimeResult`.
 *
 * All three CLI runtimes (claude-code, codex, opencode) had spelled out the
 * same ~30-line tail of `execute()`: build a `handleLine` closure that parses
 * a line / pushes it to an array / fans the extracted steps out to `onStep`,
 * wrap it in a {@link createStdoutLineReader}, call `runCliProcess` with the
 * same `onSpawn` pid-renaming shim, `flush()`, {@link warnIfTruncated},
 * short-circuit on `result.aborted` via {@link cancelledResult}, and finally
 * {@link finalizeCliResult} the parsed result. Only the event type and the
 * three provider-specific functions ever differed, so they are the
 * parameters here and everything else is shared.
 *
 * `parseLine`, `extractSteps` and `buildResult` stay injected rather than
 * being looked up from a registry: they are the genuinely provider-specific
 * half (each CLI has its own event schema) and keeping them as arguments
 * means this helper needs no knowledge of which runtimes exist.
 *
 * `cleanup` runs after the process settles on *every* path — abort included —
 * and after `buildResult`, so a runtime that reads a scratch file the CLI
 * wrote (codex's `--output-last-message`) can read it in `buildResult` and
 * still have it removed here.
 */
export async function runStreamingCliSession<E>(opts: {
  /** Log prefix for the stdout-truncation warning, e.g. `"CodexRuntime"`. */
  tag: string;
  /** Everything `runCliProcess` needs that isn't derived from `context`. */
  spawn: Omit<CliProcessOptions, "abortSignal" | "onLog" | "onSpawn">;
  /** The live callbacks + abort signal for this session. */
  context: Pick<RuntimeContext, "onStep" | "onSpawn" | "abort_signal">;
  /** Parse one stdout line into a provider event, or `null` to skip it. */
  parseLine: (line: string) => E | null;
  /** Derive the live transcript steps a single event contributes. */
  extractSteps: (event: E) => RuntimeStep[];
  /** Map the collected event stream to a result (not called when aborted). */
  buildResult: (
    events: E[],
    exitCode: number | null,
  ) => Omit<RuntimeResult, "process_pid" | "process_group_id">;
  /** Best-effort teardown, run on every path once the process has settled. */
  cleanup?: () => void;
}): Promise<RuntimeResult> {
  const events: E[] = [];
  // Parse incrementally during streaming rather than re-parsing the whole
  // stdout after close; the line reader handles chunk boundaries (a single
  // JSON event can arrive split across chunks).
  const stdout = createStdoutLineReader((line) => {
    const event = opts.parseLine(line);
    if (!event) return;
    events.push(event);
    if (!opts.context.onStep) return;
    for (const step of opts.extractSteps(event)) {
      opts.context.onStep(step);
    }
  });

  const result = await runCliProcess({
    ...opts.spawn,
    abortSignal: opts.context.abort_signal,
    onSpawn: ({ pid, process_group_id }) => {
      opts.context.onSpawn?.({ process_pid: pid, process_group_id });
    },
    onLog: stdout.onLog,
  });
  // Emit any final partial line (a stream that ended without a trailing \n).
  stdout.flush();

  warnIfTruncated(opts.tag, result);

  try {
    if (result.aborted) return cancelledResult(result);
    return finalizeCliResult(opts.buildResult(events, result.exitCode), result);
  } finally {
    // `finally` so a parser bug can't leak the scratch file the CLI left
    // behind; `buildResult` has already read it by this point.
    opts.cleanup?.();
  }
}
