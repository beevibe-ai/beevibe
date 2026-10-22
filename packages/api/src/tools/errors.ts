/**
 * The MCP tool error envelope, in one place.
 *
 * Every agent tool reports failure as an `AgentToolResult` with
 * `isError: true` and a `content` object. Two shapes were being
 * hand-rolled across the tool modules:
 *
 *   - `{ error: <code>, message: <human text> }` — a known, named
 *     failure the calling agent can branch on. `watch.ts` had this as a
 *     private `errResult`; most other modules wrote the literal inline.
 *   - `{ error: <message> }` — the catch-all for an unexpected throw.
 *     `mesh.ts` and `hierarchy.ts` each had a private `asError` for it.
 *
 * Note the catch-all puts the human message in `error`, where the coded
 * shape puts a stable code there. That is the existing wire contract on
 * both paths, preserved here rather than harmonized — agents already
 * branch on `error` for the coded tools.
 */

import { CodedMeshError } from "../mesh/types.js";
import type { AgentToolResult } from "./types.js";

/**
 * A named failure: `code` is the stable identifier the agent branches
 * on, `message` is for the human reading the transcript. `extra` merges
 * in structured context (ids, limits) alongside them.
 */
export function toolError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): AgentToolResult {
  return { content: { error: code, message, ...extra }, isError: true };
}

/**
 * A named failure whose human message is a caught error's.
 *
 * `{ error: "<code>", message: err instanceof Error ? err.message :
 * String(err) }` was written out at four call sites —
 * `update-core-memory`'s `update_failed`, `use-repo`'s
 * `dispatch_failed` and `repo_run_create_failed`, `session-search`'s
 * `internal_error`. Unlike {@link toolErrorFromThrown} these keep a
 * stable code in `error` and put the detail in `message`, which is the
 * shape those tools already promise their callers.
 */
export function toolErrorFrom(
  code: string,
  err: unknown,
  extra: Record<string, unknown> = {},
): AgentToolResult {
  return toolError(code, err instanceof Error ? err.message : String(err), extra);
}

/**
 * Envelope for something thrown out of a tool handler.
 *
 * A {@link CodedMeshError} keeps its code and meta — that's the whole
 * point of raising one. Anything else degrades to the catch-all shape,
 * with `extra` carrying whatever context the call site can add (which
 * agent, which request) to an otherwise opaque failure.
 */
export function toolErrorFromThrown(
  err: unknown,
  extra: Record<string, unknown> = {},
): AgentToolResult {
  if (err instanceof CodedMeshError) {
    return {
      content: { error: err.code, ...err.meta, message: err.message },
      isError: true,
    };
  }
  return {
    content: {
      error: err instanceof Error ? err.message : String(err),
      ...extra,
    },
    isError: true,
  };
}
