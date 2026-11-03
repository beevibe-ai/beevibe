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
 * The placeholder output a parser emits when the CLI exited non-zero with
 * no final message of its own to surface. Lives here rather than in one
 * adapter because all three parsers fall back to it — codex and opencode
 * used to import it out of `claude-code/stream-json.js`, which made a
 * cross-runtime contract look like a claude-code detail.
 *
 * Still re-exported from `claude-code/stream-json.ts` so the public
 * `@beevibe/core/adapters/claude-code` surface is unchanged.
 */
export function bareCliExitMessage(exitCode: number | null): string {
  return `CLI exited with code ${exitCode}`;
}

/**
 * Matches strings produced by {@link bareCliExitMessage} — the only
 * "useless" stand-in this layer emits on failure. Consumers that want to
 * swap a bare exit for a friendlier diagnostic gate on this predicate so
 * the coupling stays in one place.
 */
export function isBareCliExitMessage(s: string): boolean {
  return /^CLI exited with code (-?\d+|null)$/.test(s);
}

/**
 * Pick the `output` field of a parsed `RuntimeResult`.
 *
 * All three parsers resolve the same three-way preference, and the codex
 * and opencode copies were byte-identical down to the comment explaining
 * the `||`:
 *
 * - failed: the CLI's own failure message, else whatever assistant text
 *   we did see, else {@link bareCliExitMessage} so the chat route's
 *   failure-mapping can swap it for stderr / a daemon pointer.
 * - succeeded: `preferredOutput` (codex's file-backed last message — the
 *   canonical final text when present), else the assistant text, else the
 *   "nothing went wrong, nothing was said" stand-in.
 *
 * `||` throughout, not `??`: an empty string must fall through to the next
 * branch rather than short-circuit as a present-but-blank value. That is
 * the bug this helper exists to stop re-introducing per adapter.
 */
export function selectCliOutput(opts: {
  failed: boolean;
  /** The CLI's own error text, when it reported one. */
  failureMessage?: string;
  /** Assistant text recovered from the event stream. */
  assistantText: string;
  /** Out-of-band final text that wins over `assistantText` on success. */
  preferredOutput?: string;
  exitCode: number | null;
}): string {
  if (opts.failed) {
    return opts.failureMessage || opts.assistantText || bareCliExitMessage(opts.exitCode);
  }
  return opts.preferredOutput || opts.assistantText || "Session completed.";
}

/** Max characters of a tool payload kept in a transcript / step label. */
export const TRANSCRIPT_DETAIL_MAX = 200;

/**
 * Flatten a payload to one transcript-safe line: capped at
 * {@link TRANSCRIPT_DETAIL_MAX} characters with newlines folded to
 * spaces, so one tool result can't blow out the transcript or break the
 * one-entry-per-line format the summarizers read.
 */
export function truncateInline(value: string): string {
  return value.slice(0, TRANSCRIPT_DETAIL_MAX).replace(/\n/g, " ");
}

/**
 * The transcript's line format, in one place.
 *
 * `session.transcript` is consumed by downstream LLMs (session search,
 * handoff summaries), which key off these `[tag]` prefixes. Each adapter
 * used to build the strings inline, so a drifting space or a renamed tag
 * in one runtime would silently produce transcripts the summarizers read
 * differently depending on which CLI happened to run.
 */
export const transcriptLine = {
  assistant: (text: string): string => `[assistant] ${text}\n`,
  toolCall: (tool: string, detail?: string): string =>
    detail ? `[tool_call] ${tool} ${detail}\n` : `[tool_call] ${tool}\n`,
  /** `tool` undefined renders the anonymous `[tool_result]` form. */
  toolResult: (tool: string | undefined, detail?: string): string => {
    if (!tool) return "[tool_result]\n";
    return detail ? `[tool_result from ${tool}] ${detail}\n` : `[tool_result from ${tool}]\n`;
  },
  error: (message: string): string => `[error] ${message}\n`,
} as const;

/** What {@link runStreamingCli} hands back: the parsed events plus the process outcome. */
export interface StreamingCliRun<E> {
  /** Every line that `parseLine` accepted, in arrival order. */
  events: E[];
  result: CliProcessResult;
}

export interface StreamingCliOptions<E> {
  /** Log tag for the truncation warning, e.g. `"CodexRuntime"`. */
  runtimeTag: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Piped to the child's stdin. Only claude-code feeds the intent this way. */
  stdin?: string;
  /** Supplies `abort_signal`, `onStep` and `onSpawn`. */
  context: RuntimeContext;
  /** Provider-specific NDJSON line parser; `null` skips the line. */
  parseLine: (line: string) => E | null;
  /** Provider-specific per-event step extraction, for `context.onStep`. */
  extractSteps: (event: E) => RuntimeStep[];
}

/**
 * Spawn a CLI, stream its NDJSON stdout, and return the parsed events.
 *
 * This is the whole middle of every runtime's `execute()`: accumulate
 * events while emitting `onStep` for each one, spawn through
 * {@link runCliProcess} forwarding pid/pgid to `onSpawn`, flush the
 * trailing partial line, and warn if stdout hit the capture cap. All
 * three adapters had their own copy, and the steps have to stay in
 * lockstep — forgetting `flush()` drops the last event of a stream with
 * no trailing newline, and forgetting `warnIfTruncated` loses the only
 * signal that a parsed result is incomplete.
 *
 * What stays per-adapter is what genuinely differs: argv and env
 * construction before the call, and turning the events into a
 * `RuntimeResult` after it (including the `result.aborted` check, since
 * codex has a temp file to clean up on that path).
 */
export async function runStreamingCli<E>(
  opts: StreamingCliOptions<E>,
): Promise<StreamingCliRun<E>> {
  const { context } = opts;
  // Parse incrementally during streaming rather than re-reading stdout
  // after close; the line reader handles chunk boundaries (one JSON
  // message can arrive split across several chunks).
  const events: E[] = [];
  const stdout = createStdoutLineReader((line) => {
    const event = opts.parseLine(line);
    if (!event) return;
    events.push(event);
    if (!context.onStep) return;
    for (const step of opts.extractSteps(event)) context.onStep(step);
  });

  const result = await runCliProcess({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
    abortSignal: context.abort_signal,
    onSpawn: ({ pid, process_group_id }) => {
      context.onSpawn?.({ process_pid: pid, process_group_id });
    },
    onLog: stdout.onLog,
  });

  // Flush any final partial line (stream without a trailing \n).
  stdout.flush();
  warnIfTruncated(opts.runtimeTag, result);

  return { events, result };
}
