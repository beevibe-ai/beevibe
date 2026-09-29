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
 *   - `{ error: <message> }` — argument validation with no stable code,
 *     and the catch-all for an unexpected throw. `mesh.ts` and
 *     `hierarchy.ts` each had a private `asError` for the latter.
 *
 * Note the uncoded shape puts the human message in `error`, where the
 * coded shape puts a stable code there. That is the existing wire
 * contract on both paths, preserved here rather than harmonized — agents
 * already branch on `error` for the coded tools. {@link toolError}
 * produces either, which is why its `message` is optional.
 */

import { CodedMeshError } from "../mesh/types.js";
import type { AgentToolResult } from "./types.js";
import { errorMessage } from "@beevibe/core/domain/errors";

/**
 * A failure envelope: `error` is what the agent reads first, `message` is
 * for the human reading the transcript, and `extra` merges in structured
 * context (ids, limits, counts) alongside them.
 *
 * `message` is optional because the existing wire contract has three live
 * shapes, and this has to produce all of them byte-for-byte:
 *
 *   toolError("not_subordinate", "Cannot assign tasks to …")
 *     → { error: <code>, message: <prose> }   the coded shape
 *   toolError("task_not_found", undefined, { task_id })
 *     → { error: <code>, task_id }            a code whose context IS the message
 *   toolError("task_id required")
 *     → { error: <prose> }                    the uncoded shape
 *
 * The third is what most of the argument validation in `hierarchy.ts` and
 * `mesh.ts` returns: there is no stable code, so the prose sits in `error`
 * itself. Harmonizing the three would be a wire change for agents that
 * already branch on `error`, so this factors out the envelope only.
 *
 * `message` is omitted from `content` entirely when not passed, rather
 * than serialized as `message: undefined` — `JSON.stringify` drops it
 * either way, but an omitted key keeps the object identical to the
 * literals this replaces under `toEqual`.
 */
export function toolError(
  error: string,
  message?: string,
  extra: Record<string, unknown> = {},
): AgentToolResult {
  return {
    content: { error, ...(message === undefined ? {} : { message }), ...extra },
    isError: true,
  };
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
      error: errorMessage(err),
      ...extra,
    },
    isError: true,
  };
}
