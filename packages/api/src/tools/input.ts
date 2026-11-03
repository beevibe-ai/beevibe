/**
 * Required-argument reading for MCP tool handlers.
 *
 * Every tool handler receives `input: Record<string, unknown>` straight
 * off the wire, so each one that takes a mandatory string argument grew
 * the same preamble: coerce with `String(input.x ?? "")`, then reject the
 * empty result. Sixteen handlers across `hierarchy` and `mesh` had a copy,
 * and the one thing worth keeping consistent — the message the agent sees
 * — was spelled out by hand at every site.
 *
 * This is the tool-side counterpart of `routes/http-errors.ts`'s
 * `requireParam`. The difference is that a tool handler has no `res` to
 * write to, so the error has to travel back as a value rather than a
 * side effect; hence the two-armed result instead of `undefined`.
 *
 * The wording is derived, not passed in: `"<key> required"` for one key
 * and `"<a> and <b> required"` for two, which is byte-for-byte what all
 * sixteen call sites already returned. Handlers whose message is NOT of
 * that form (`create_subordinate_agent`'s `missing_required_fields`
 * listing four fields, `search_context`'s own prose) keep their own
 * literal — this factors out the shape, not the prose.
 */

import type { AgentToolResult } from "./types.js";

/**
 * Either the read values or the error to return, never both.
 *
 * Discriminate on `error` so the caller's guard reads
 * `if (args.error) return args.error;` — the same early-return shape as
 * `requireHuman` / `requireParam` on the HTTP side.
 */
export type RequiredArgs<K extends string> =
  | { values: Record<K, string>; error?: undefined }
  | { values?: undefined; error: AgentToolResult };

/**
 * Read one or more mandatory string arguments.
 *
 * Non-string values are coerced with `String()` — preserving the
 * long-standing `String(input.x ?? "")` behavior, under which a number
 * argument is accepted as its decimal form and `null`/`undefined`/`""`
 * are all rejected as absent.
 *
 * Validation happens after all keys are read, so the message names every
 * required key rather than just the first missing one — again matching
 * the existing `"task_id and title required"` call sites.
 *
 * ```ts
 * const args = requireStringArgs(input, ["task_id", "title"]);
 * if (args.error) return args.error;
 * const { task_id: taskId, title } = args.values;
 * ```
 *
 * @param trim When set, values are trimmed before the emptiness check,
 *   so an all-whitespace argument is rejected rather than passed through.
 */
export function requireStringArgs<K extends string>(
  input: Record<string, unknown>,
  keys: readonly K[],
  opts: { trim?: boolean } = {},
): RequiredArgs<K> {
  const values = {} as Record<K, string>;
  let missing = false;
  for (const key of keys) {
    const raw = String(input[key] ?? "");
    const value = opts.trim ? raw.trim() : raw;
    values[key] = value;
    if (!value) missing = true;
  }
  if (missing) {
    return { error: { content: { error: missingMessage(keys) }, isError: true } };
  }
  return { values };
}

/**
 * `"id required"` / `"task_id and title required"`.
 *
 * Two keys join with `" and "`, which is every multi-key site in the tool
 * layer today. Three or more would read badly as `"a and b and c"`, but
 * no call site has that shape — the one handler that needs four fields
 * (`create_subordinate_agent`) deliberately keeps its own prose message
 * instead of going through here.
 */
function missingMessage(keys: readonly string[]): string {
  return `${keys.join(" and ")} required`;
}
