/**
 * Handler-construction boilerplate for agent tools, in one place.
 *
 * Every tool in this directory was spelling out the same two things by
 * hand around its actual body:
 *
 *   - `try { … } catch (err) { return toolErrorFromThrown(err); }` —
 *     22 copies across `hierarchy`, `mesh`, `watch`, `session-search`
 *     and `update-core-memory`. `routes/mcp.ts` already catches a throw
 *     out of a handler, but its envelope is the flat
 *     `{ error: err.message }`, which drops a {@link CodedMeshError}'s
 *     `code` and `meta`. The per-handler guard is what preserves those,
 *     so it has to stay — it just doesn't have to be re-typed.
 *   - `const id = String(input.x ?? ""); if (!id) return { content: {
 *     error: "x required" }, isError: true };` — 7 copies in
 *     `hierarchy`, one per id-taking tool.
 *
 * This is the tools-layer counterpart to `routes/http-errors.ts`, which
 * did the same job for the Express handlers. As there, the pieces that
 * genuinely differ per call site (error codes, validation wording) stay
 * at the call site; only the shape is factored out.
 */

import { toolErrorFromThrown } from "./errors.js";
import type { AgentTool, AgentToolResult } from "./types.js";

/**
 * Wrap a tool handler body so anything it throws becomes an error
 * envelope instead of escaping to the MCP route.
 *
 * `mapError` defaults to {@link toolErrorFromThrown} — the catch-all
 * every migrated call site already used. Pass it when a module maps its
 * own error classes to stable codes first: `watch.ts` has a
 * WatchAuthError / WatchValidationError / WatchNotFoundError table, and
 * `session-search.ts` unwraps SessionSearchError's `code`.
 */
export function guarded(
  body: (input: Record<string, unknown>) => Promise<AgentToolResult>,
  mapError: (err: unknown) => AgentToolResult = toolErrorFromThrown,
): AgentTool["handler"] {
  return async (input) => {
    try {
      return await body(input);
    } catch (err) {
      return mapError(err);
    }
  };
}

/**
 * Read a required id-ish argument, throwing `<key> required` when it is
 * absent or empty.
 *
 * Inside a {@link guarded} body that throw lands in
 * {@link toolErrorFromThrown}, whose catch-all puts the message in
 * `error` — so the wire result is byte-identical to the
 * `{ content: { error: "task_id required" }, isError: true }` the call
 * sites returned before.
 *
 * `String(…)` coercion rather than a `typeof` check, deliberately: the
 * replaced code read `String(input.task_id ?? "")`, so a client sending
 * a number got it stringified and accepted. Narrowing that to
 * strings-only would be a behavior change for callers that currently
 * work, so it stays coercing.
 */
export function requireString(input: Record<string, unknown>, key: string): string {
  const value = String(input[key] ?? "");
  if (!value) throw new Error(`${key} required`);
  return value;
}
