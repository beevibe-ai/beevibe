/**
 * Argument coercion for MCP agent-tool handlers.
 *
 * A tool handler receives `Record<string, unknown>` — the JSON the model
 * emitted, validated by nothing. Every handler therefore opens with the
 * same coercion preamble, and across `hierarchy.ts`, `mesh.ts`,
 * `watch.ts`, `use-repo.ts` and `session-search.ts` the same five idioms
 * were written out by hand roughly forty times:
 *
 *   - `String(input.x ?? "")` for a required string (34 sites)
 *   - `typeof input.x === "string" ? input.x : undefined` (13 sites)
 *   - `typeof input.x === "number" ? input.x : undefined` (4 sites)
 *   - `Array.isArray(input.x) ? input.x.filter(…) : undefined` (5 sites)
 *   - `input.x && typeof input.x === "object" ? (input.x as …) : undefined`
 *
 * These are behavior-preserving names for exactly those expressions —
 * note in particular that {@link stringArg} keeps `String(…)`'s coercion
 * of a non-string (a model that sends `task_id: 5` gets `"5"`, as it
 * always has) rather than tightening to a `typeof` check. Tightening it
 * would be a wire-contract change, not a refactor.
 *
 * The guard itself stays at the call site. It is deliberately NOT folded
 * into a combined "read and validate" helper: several tools read more
 * args than they guard (`create_work_product` reads `task_id`, `type`
 * and `title` but rejects only on the first and last), so a helper that
 * validated everything it read would reject input the tools accept
 * today.
 */

import type { AgentToolResult } from "./types.js";

/**
 * A required string arg: `String(input[key] ?? "")`.
 *
 * Returns `""` for absent/null, which is what the callers' `if (!x)`
 * guards test. Pair with {@link missingArgs} for the rejection.
 */
export function stringArg(input: Record<string, unknown>, key: string): string {
  return String(input[key] ?? "");
}

/** {@link stringArg} with surrounding whitespace stripped. */
export function trimmedArg(input: Record<string, unknown>, key: string): string {
  return stringArg(input, key).trim();
}

/**
 * The "you didn't pass these" rejection, in the wording the tools
 * already use: `missingArgs("task_id", "feedback")` produces
 * `{ error: "task_id and feedback required" }`.
 *
 * Deriving the message from the arg names is the point — it was
 * previously a hand-written string sitting next to a hand-written guard,
 * so renaming an arg left the error naming the old one.
 */
export function missingArgs(...names: string[]): AgentToolResult {
  const list =
    names.length <= 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return { content: { error: `${list} required` }, isError: true };
}

/** An optional string arg, `undefined` when absent or not a string. */
export function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = input[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * An optional string arg that must be non-empty, kept verbatim —
 * `undefined` for absent, non-string, or `""`.
 *
 * Distinct from {@link optionalTrimmedString}, which also strips: a
 * whitespace-only value survives this one and not that one. The call
 * sites really do differ (`create_task`'s `repo_url` is stored as sent;
 * `session_search`'s `query` is trimmed before matching), so the two
 * behaviors get two names rather than one helper with a flag nobody
 * would read.
 */
export function optionalNonEmptyString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = input[key];
  return typeof v === "string" && v ? v : undefined;
}

/**
 * An optional string arg that must carry something once trimmed, and is
 * returned trimmed — `undefined` for absent, non-string, empty, or
 * whitespace-only.
 */
export function optionalTrimmedString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = input[key];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed : undefined;
}

/** An optional number arg, `undefined` when absent or not a number. */
export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = input[key];
  return typeof v === "number" ? v : undefined;
}

/**
 * An optional `string[]` arg, with non-string elements dropped rather
 * than rejected — a model that puts a number in an array of questions
 * loses that element, it doesn't lose the call. `undefined` when the arg
 * isn't an array at all, so callers can distinguish "not supplied" from
 * "supplied empty".
 */
export function optionalStringArray(
  input: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const v = input[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/**
 * An optional structured-object arg (a `metadata` / `filters` bag).
 *
 * Arrays pass, because `typeof [] === "object"` and both call sites this
 * replaces let them through. That is almost certainly not what either
 * tool wants, but rejecting them here would change what
 * `create_work_product` accepts, so it stays a separate decision from
 * this refactor.
 */
export function optionalObject(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = input[key];
  if (!v || typeof v !== "object") return undefined;
  return v as Record<string, unknown>;
}
