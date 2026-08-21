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
 *     {@link toolError}.
 *   - `{ error: <message> }` — the catch-all for an unexpected throw,
 *     and the shape the argument guards answer with.
 *     `mesh.ts` and `hierarchy.ts` each had a private `asError` for it.
 *     {@link toolFailure} / {@link toolErrorFromThrown}.
 *
 * Note the catch-all puts the human message in `error`, where the coded
 * shape puts a stable code there. That is the existing wire contract on
 * both paths, preserved here rather than harmonized — agents already
 * branch on `error` for the coded tools.
 *
 * These two builders are the only way the tool modules should construct
 * a failure. Fifty-six inline copies of the literal came before them,
 * and an inline copy is one `isError: true` away from an MCP result that
 * reads as success.
 */

import { errorMessage } from "@beevibe/core";
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
 * The single-field failure: whatever string you pass lands in `error`,
 * with no `message` alongside it. Same wire shape
 * {@link toolErrorFromThrown} produces for an unexpected throw.
 *
 * This is the envelope the argument-validation guards in `hierarchy.ts`
 * and `mesh.ts` use — about thirty copies of the same four-line object
 * literal, written inline. What goes in that one field is not uniform
 * (most sites pass prose like `"task_id and title required"`, a couple
 * pass a bare code like `"task_not_found"`), and both are already on the
 * wire, so this factors out the shape and leaves the convention alone.
 *
 * Prefer {@link toolError} for anything new that a caller might branch
 * on. Reach for this one to match a call site that is already uncoded.
 */
export function toolFailure(
  message: string,
  extra: Record<string, unknown> = {},
): AgentToolResult {
  return { content: { error: message, ...extra }, isError: true };
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
