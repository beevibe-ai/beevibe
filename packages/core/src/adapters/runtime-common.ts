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
/**
 * Max characters of a tool input, tool result, or command rendered into a
 * `RuntimeStep.description` or a transcript line. Every CLI adapter capped
 * these at 200 with its own literal; the cap is a UI/transcript concern
 * shared by all of them, so it lives here.
 */
export const TRANSCRIPT_SNIPPET_MAX = 200;

/**
 * Truncate `text` to `max` chars and flatten embedded newlines to spaces, so
 * the result is safe to splice into a single `[tag] …` transcript line.
 * `undefined` / `null` collapse to `""`.
 *
 * Slices *before* flattening, matching what every adapter did by hand.
 */
export function oneLineSnippet(
  text: string | undefined | null,
  max: number = TRANSCRIPT_SNIPPET_MAX,
): string {
  if (!text) return "";
  return text.slice(0, max).replace(/\n/g, " ");
}

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
  if (typeof input === "string") return input.slice(0, TRANSCRIPT_SNIPPET_MAX);
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const obj = input as Record<string, unknown>;
  for (const key of fields) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v.slice(0, TRANSCRIPT_SNIPPET_MAX);
  }
  return JSON.stringify(input).slice(0, TRANSCRIPT_SNIPPET_MAX);
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
 * Output text for a session that ran to completion without the CLI
 * surfacing any final assistant message. Shared so the three adapters
 * can't drift on the exact string (the web UI matches on it).
 */
export const SESSION_COMPLETED_OUTPUT = "Session completed.";

/**
 * The placeholder `resolveCliOutput` returns when the CLI exited non-zero
 * with no message to surface. Exported so downstream consumers (the chat
 * route's user-facing failure mapping) can detect this exact string and
 * replace it with something more actionable instead of pattern-matching
 * across package boundaries.
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
 * Pick the `RuntimeResult.output` text from the candidates a parser dug out
 * of the event stream, most-specific first, falling back to the shared
 * terminal strings.
 *
 * All three CLI parsers ended a run with the same chain — "first candidate
 * that isn't empty, else `Session completed.` on success / the bare exit
 * message on failure". Candidates are taken as-is (callers trim where they
 * want trimming), and an empty string falls *through* to the next candidate
 * rather than short-circuiting, which is why the adapters all wrote `||`
 * rather than `??` here.
 */
export function resolveCliOutput(opts: {
  failed: boolean;
  exitCode: number | null;
  candidates: ReadonlyArray<string | undefined>;
}): string {
  for (const candidate of opts.candidates) {
    if (candidate) return candidate;
  }
  return opts.failed ? bareCliExitMessage(opts.exitCode) : SESSION_COMPLETED_OUTPUT;
}

/**
 * Accumulator for the human-readable transcript persisted alongside a
 * session.
 *
 * The `[assistant] …` / `[tool_call] …` / `[tool_result from X] …` /
 * `[error] …` line format is a cross-provider contract — transcript
 * summarizers and the session detail UI parse these tags — but each
 * adapter was building the lines with its own template literals. One
 * builder keeps the tags, the spacing, and the trailing newline identical
 * across providers.
 */
export interface TranscriptBuilder {
  /** `[assistant] <text>` */
  assistant(text: string): void;
  /** `[tool_call] <tool>`, plus ` <detail>` when a detail is given. */
  toolCall(tool: string, detail?: string): void;
  /**
   * `[tool_result from <tool>]`, plus ` <detail>` when a detail is given.
   * A missing `tool` degrades to a bare `[tool_result]` — Claude Code can
   * emit a result whose `tool_use_id` never correlated to a call.
   */
  toolResult(tool: string | undefined, detail?: string): void;
  /** `[error] <message>` */
  error(message: string): void;
  /** The assembled transcript, or `undefined` when nothing was pushed. */
  value(): string | undefined;
}

export function createTranscript(): TranscriptBuilder {
  const parts: string[] = [];
  /** `[<tag>] <detail>` — or a bare `[<tag>]` when there is no detail. */
  const line = (tag: string, detail?: string): void => {
    parts.push(detail ? `[${tag}] ${detail}\n` : `[${tag}]\n`);
  };
  return {
    assistant: (text) => line("assistant", text),
    toolCall: (tool, detail) => line("tool_call", detail ? `${tool} ${detail}` : tool),
    toolResult: (tool, detail) =>
      tool === undefined ? line("tool_result") : line(`tool_result from ${tool}`, detail),
    error: (message) => line("error", message),
    value: () => parts.join("") || undefined,
  };
}

/**
 * Buffer stdout into whole lines, parse each one into a provider event, push
 * it onto `events`, and fan the derived {@link RuntimeStep}s out to `onStep`.
 *
 * Every CLI runtime's `execute()` had this same twelve-line block, differing
 * only in the parse/extract pair and the event type. Parsing incrementally
 * during streaming (rather than re-splitting the accumulated stdout after
 * close) is what lets `onStep` drive a live transcript, so the buffering and
 * the parsing have to stay wired together.
 *
 * Callers must call `flush()` once the process settles, to pick up a final
 * line that arrived without a trailing newline.
 */
export interface CliEventCollector<E> {
  /** Events parsed so far, in stream order. */
  readonly events: E[];
  onLog: (stream: "stdout" | "stderr", chunk: string) => void;
  flush: () => void;
}

export function createCliEventCollector<E>(opts: {
  parse: (line: string) => E | null;
  extractSteps: (event: E) => RuntimeStep[];
  onStep?: ((step: RuntimeStep) => void) | undefined;
}): CliEventCollector<E> {
  const events: E[] = [];
  const reader = createStdoutLineReader((line) => {
    const event = opts.parse(line);
    if (!event) return;
    events.push(event);
    const { onStep } = opts;
    if (!onStep) return;
    for (const step of opts.extractSteps(event)) onStep(step);
  });
  return { events, onLog: reader.onLog, flush: reader.flush };
}
