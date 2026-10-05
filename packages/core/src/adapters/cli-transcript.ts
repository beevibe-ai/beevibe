/**
 * The persisted-transcript wire format shared by every CLI runtime.
 *
 * All three stream-json parsers (claude-code, codex, opencode) build the
 * same line-oriented transcript from their own event schemas, and each had
 * spelled the line templates out inline — 14 `transcriptParts.push(...)`
 * call sites across the three files, with `[assistant] `, `[tool_call] `,
 * `[tool_result from <tool>] ` and `[error] ` retyped at each one.
 *
 * The tags are not an implementation detail of any one adapter: they are a
 * cross-provider contract, the same way `composePrompt`'s
 * `<beevibe_system_context>` block is. A transcript parsed out of one
 * runtime has to read the same as one from another, so the templates belong
 * in a single place rather than in three that can drift independently.
 *
 * Collecting them here also means the one-line flattening rule
 * (`DETAIL_MAX_CHARS` + newlines collapsed to spaces) is applied the same
 * way everywhere — the adapters had each written `.slice(0, 200)
 * .replace(/\n/g, " ")` by hand, and claude-code's tool_result path had
 * been written without a `trim`.
 */

/**
 * Cap on a tool-call/-result detail appended to a transcript line. The
 * transcript is fed to downstream LLM summarizers, so a single multi-megabyte
 * tool output must not crowd out the rest of the session.
 */
export const DETAIL_MAX_CHARS = 200;

/**
 * Flatten a tool detail to one transcript line: collapse newlines to spaces
 * and truncate to {@link DETAIL_MAX_CHARS}. Truncating *after* collapsing
 * keeps the budget in visible characters rather than spending it on
 * whitespace.
 */
export function oneLineDetail(text: string): string {
  return text.replace(/\n/g, " ").slice(0, DETAIL_MAX_CHARS);
}

/**
 * Accumulator for a session transcript.
 *
 * Mirrors what the three parsers already did by hand — push formatted lines
 * onto an array, join at the end, and return `undefined` rather than an
 * empty string when nothing was recorded (the `transcript` field on
 * `RuntimeResult` is optional and callers distinguish absent from empty).
 */
export class CliTranscript {
  private readonly lines: string[] = [];

  /** Assistant prose. */
  assistant(text: string): void {
    this.lines.push(`[assistant] ${text}\n`);
  }

  /**
   * A tool invocation. `detail` is optional because only codex has anything
   * to say at call time (the shell command); the other runtimes learn the
   * arguments too late to put them here.
   */
  toolCall(tool: string, detail?: string): void {
    this.lines.push(
      detail ? `[tool_call] ${tool} ${oneLineDetail(detail)}\n` : `[tool_call] ${tool}\n`,
    );
  }

  /**
   * A tool's result. `tool` is optional: claude-code correlates a
   * `tool_result` back to its `tool_use` by id and that lookup can miss, in
   * which case the line degrades to a bare `[tool_result]` rather than
   * claiming the wrong tool.
   */
  toolResult(tool: string | undefined, detail?: string): void {
    const head = tool ? `[tool_result from ${tool}]` : "[tool_result]";
    this.lines.push(detail ? `${head} ${oneLineDetail(detail)}\n` : `${head}\n`);
  }

  /** A runtime-level error event (not a failing tool call). */
  error(message: string): void {
    this.lines.push(`[error] ${message}\n`);
  }

  /** The joined transcript, or `undefined` when no line was recorded. */
  text(): string | undefined {
    return this.lines.length > 0 ? this.lines.join("") : undefined;
  }
}
