import { tmpdir } from "node:os";
import type {
  RuntimeContext,
  RuntimeHealth,
  RuntimeResult,
  RuntimeStep,
} from "../ports/runtime.js";
import { type CliProcessResult, runCliProcess } from "./claude-code/spawn.js";

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
 * How much of a tool's input or output a transcript line carries. Long
 * enough to identify the call, short enough that a chatty session doesn't
 * blow up the persisted transcript (or the summarizer's context).
 */
export const TRANSCRIPT_SNIPPET_CHARS = 200;

/**
 * Collapse a tool payload onto one transcript line: truncate, then flatten
 * newlines to spaces so a multi-line command output can't fake extra
 * transcript entries.
 */
export function inlineSnippet(text: string, max = TRANSCRIPT_SNIPPET_CHARS): string {
  return text.slice(0, max).replace(/\n/g, " ");
}

/*
 * The persisted-transcript line format.
 *
 * `[assistant] …` / `[tool_call] …` / `[tool_result from X] …` / `[error] …`
 * is a cross-provider contract, not per-adapter cosmetics: the transcript
 * summarizer and downstream LLM consumers key off these tags, and the web
 * transcript view renders them. All three parsers had spelled the same
 * template literals out by hand, which is three places to drift. The
 * builders below are the single definition.
 */

/** One assistant text block. */
export function assistantLine(text: string): string {
  return `[assistant] ${text}\n`;
}

/**
 * One tool invocation. `detail` is an optional already-snippeted argument
 * summary (codex appends the shell command); omitted or empty renders the
 * bare `[tool_call] <tool>` form.
 */
export function toolCallLine(tool: string, detail?: string): string {
  return detail ? `[tool_call] ${tool} ${detail}\n` : `[tool_call] ${tool}\n`;
}

/**
 * One tool result. An unknown `tool` degrades to the opaque `[tool_result]`
 * form — and drops `detail` with it, since an unattributed payload is more
 * confusing to a downstream reader than no payload at all. That case only
 * arises for Claude Code results whose `tool_use_id` never appeared in an
 * assistant block.
 */
export function toolResultLine(tool: string | undefined, detail?: string): string {
  if (!tool) return "[tool_result]\n";
  return detail ? `[tool_result from ${tool}] ${detail}\n` : `[tool_result from ${tool}]\n`;
}

/** A run-level error event (codex `error` / `turn.failed`, opencode `error`). */
export function errorLine(message: string): string {
  return `[error] ${message}\n`;
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

export interface CliStreamOptions<Event> {
  /** Log tag for the truncation warning — e.g. `"CodexRuntime"`. */
  runtimeTag: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Piped to the child's stdin. Only Claude Code uses this (`--print -`). */
  stdin?: string;
  /** Supplies `abort_signal`, `onSpawn` and `onStep`. */
  context: RuntimeContext;
  /** Provider-specific NDJSON line parser; `null` skips the line. */
  parseLine: (line: string) => Event | null;
  /** Provider-specific event → live-transcript steps. */
  extractSteps: (event: Event) => RuntimeStep[];
}

export interface CliStreamOutcome<Event> {
  /** Every event parsed off stdout, in arrival order. */
  events: Event[];
  result: CliProcessResult;
}

/**
 * Spawn a CLI runtime and collect its NDJSON event stream.
 *
 * All three CLI adapters run the identical sequence around their own parser:
 * accumulate events off a line reader, forward each one's steps to
 * `context.onStep`, spawn, flush the trailing partial line, then warn if
 * stdout hit the capture cap. Only the event schema and what happens *after*
 * the process settles differ, so this owns the streaming half and hands back
 * the raw events — each adapter still decides how to turn them into a
 * `RuntimeResult` (codex, for one, also has an `--output-last-message` file
 * to read and clean up on both the aborted and the completed path).
 *
 * Steps are forwarded as they parse, so the live transcript keeps updating
 * while the process runs; `events` is only used once it settles.
 */
export async function runCliStream<Event>(
  opts: CliStreamOptions<Event>,
): Promise<CliStreamOutcome<Event>> {
  const { context } = opts;
  const events: Event[] = [];

  const stdout = createStdoutLineReader((line) => {
    const event = opts.parseLine(line);
    if (!event) return;
    events.push(event);
    if (!context.onStep) return;
    for (const step of opts.extractSteps(event)) {
      context.onStep(step);
    }
  });

  const result = await runCliProcess({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
    abortSignal: context.abort_signal,
    onSpawn: ({ pid, process_group_id }) => {
      context.onSpawn?.({ process_pid: pid, process_group_id });
    },
    onLog: stdout.onLog,
  });

  // Emit any final line the stream ended without a newline after.
  stdout.flush();
  warnIfTruncated(opts.runtimeTag, result);

  return { events, result };
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
