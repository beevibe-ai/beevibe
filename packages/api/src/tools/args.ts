/**
 * Required-argument narrowing for MCP tool handlers.
 *
 * Sixteen handlers across `hierarchy.ts` and `mesh.ts` opened with the same
 * three moves: coerce each required argument with `String(input.x ?? "")`,
 * test them all for emptiness in one `if`, and return an error whose message
 * lists the same names again. Written out three times per handler, the list
 * of names had three chances to disagree with itself — a handler that grows
 * a fourth required argument gets a new `String(...)` line and a new `||`
 * clause, but the message stays as it was and the agent is told the wrong
 * thing about why its call failed.
 *
 * `requireStringArgs` derives all three from one list, so they cannot drift.
 *
 * The JSON Schema each tool ships already marks these `required`, but MCP
 * clients are not obliged to enforce it and the schema is advisory on the
 * wire — the runtime check has to exist regardless.
 */

import type { AgentToolResult } from "./types.js";

export type RequiredStringArgs<K extends string> = { [P in K]: string };

export type RequireStringArgsResult<K extends string> =
  | { ok: true; values: RequiredStringArgs<K> }
  | { ok: false; result: AgentToolResult };

/**
 * Coerce each named argument to a string and reject the call when any of
 * them is empty.
 *
 * Emptiness, not absence, is the test — matching what the hand-written
 * guards did. `String(undefined ?? "")` and an explicit `""` are the same
 * failure, and a whitespace-only value passes here exactly as it did
 * before (the handlers that want a trim do it themselves, after this).
 *
 * The rejection message is `"<a> and <b> required"` — the wording already
 * on the wire at every call site this replaces. Agents branch on
 * `content.error`, so it is reproduced verbatim rather than harmonized
 * into a coded shape.
 *
 * ```ts
 * const args = requireStringArgs(input, ["task_id", "title"]);
 * if (!args.ok) return args.result;
 * const { task_id: taskId, title } = args.values;
 * ```
 */
export function requireStringArgs<const K extends string>(
  input: Record<string, unknown>,
  keys: readonly K[],
): RequireStringArgsResult<K> {
  const values = {} as RequiredStringArgs<K>;
  for (const key of keys) {
    values[key] = String(input[key] ?? "");
  }
  if (keys.some((key) => !values[key])) {
    return {
      ok: false,
      result: { content: { error: `${keys.join(" and ")} required` }, isError: true },
    };
  }
  return { ok: true, values };
}
