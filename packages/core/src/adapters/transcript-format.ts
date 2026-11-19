/**
 * The persisted-transcript line format, in one place.
 *
 * Every CLI runtime adapter builds a `transcript` string for its
 * `RuntimeResult` by pushing tagged lines into an array:
 *
 * ```
 * [assistant] Looks like the migration never ran.
 * [tool_call] Read
 * [tool_result from Read] export async function up(pgm) { …
 * [error] thread exceeded its token budget
 * ```
 *
 * That blob is what a human reads on the session detail page and what a
 * summarizing LLM is handed for a follow-up turn, so the tags want to be
 * the same across providers — a transcript shouldn't read differently
 * depending on which CLI happened to run the session. The three adapters
 * had each written these four shapes out by hand (`[tool_result from X]`
 * with and without a detail suffix was spelled out identically in two of
 * them), which is three places for a tag to drift.
 *
 * Nothing in the repo parses these lines back out; they are display and
 * prompt material. So this module exists to keep the four shapes uniform,
 * not to guard a machine-readable contract — if you need structured
 * per-step data, read `session_event` rows instead, which is what the web
 * transcript component actually does.
 */

/**
 * How much of a tool's output or input a transcript line carries.
 *
 * A transcript holds every step of a session and rides into later prompts
 * whole, so an untruncated tool result (a file read, a `git log`, a test
 * run) would crowd out the reasoning around it. 200 chars is enough to
 * recognize *what* came back while keeping the blob proportional to the
 * number of steps rather than to their output size.
 */
export const TRANSCRIPT_DETAIL_LIMIT = 200;

/**
 * Condense a tool's output into a one-line transcript suffix: truncate to
 * {@link TRANSCRIPT_DETAIL_LIMIT}, then fold newlines to spaces.
 *
 * The fold is what keeps the format line-oriented — without it a single
 * multi-line tool result reads as several untagged lines, and whatever
 * reads the transcript next can no longer tell which step a line came
 * from. Order matters: truncating first bounds the work the replace does
 * on a megabyte of captured stdout.
 */
export function summarizeDetail(text: string): string {
  return text.slice(0, TRANSCRIPT_DETAIL_LIMIT).replace(/\n/g, " ");
}

/** `[assistant] <text>` — a visible model response. */
export function assistantLine(text: string): string {
  return `[assistant] ${text}\n`;
}

/**
 * `[tool_call] <tool>` — a tool invocation, with an optional argument
 * summary (codex appends the shell command it is about to run).
 */
export function toolCallLine(tool: string, detail?: string): string {
  return detail ? `[tool_call] ${tool} ${detail}\n` : `[tool_call] ${tool}\n`;
}

/**
 * `[tool_result from <tool>] <detail>` — what a tool returned.
 *
 * `tool` is optional because Claude Code can emit a `tool_result` whose
 * `tool_use_id` never matched a `tool_use` block, leaving the tool name
 * genuinely unknown; that degrades to a bare `[tool_result]` rather than
 * inventing an attribution. `detail` is omitted when the result was empty,
 * so the line doesn't end in a dangling space.
 */
export function toolResultLine(tool: string | undefined, detail: string): string {
  if (!tool) return "[tool_result]\n";
  return detail ? `[tool_result from ${tool}] ${detail}\n` : `[tool_result from ${tool}]\n`;
}

/** `[error] <message>` — a provider-level failure, mid-stream. */
export function errorLine(message: string): string {
  return `[error] ${message}\n`;
}
