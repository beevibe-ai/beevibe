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
 *   - `{ error: <message> }` — the catch-all. `mesh.ts` and
 *     `hierarchy.ts` each had a private `asError` for it when the cause
 *     was a thrown error, and wrote the literal inline when it was an
 *     argument-validation failure.
 *
 * Note the catch-all puts the human message in `error`, where the coded
 * shape puts a stable code there. That is the existing wire contract on
 * both paths, preserved here rather than harmonized — agents already
 * branch on `error` for the coded tools.
 *
 * Which shape a given tool speaks is therefore not ours to change in a
 * refactor: {@link toolError} is for the coded tools, and
 * {@link toolErrorMessage} / {@link toolErrorFromThrown} for the
 * catch-all ones. Picking the wrong one here would silently move the
 * human text between two fields that agents read differently.
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

/**
 * An envelope with nothing in `message`: `{ error: <text>, ...extra }`.
 *
 * Two existing kinds of failure land here, and the difference is in what
 * the caller puts in `error`, not in the shape:
 *
 *   - The argument-validation branches in `hierarchy.ts` and `mesh.ts`
 *     put a human sentence there ("task_id required", "decision must be
 *     one of: …"). They predate {@link toolError} and carry no stable
 *     code, so they cannot move onto it without relocating their text
 *     from `error` to `message` — a wire change for any agent branching
 *     on `error`.
 *   - A few `hierarchy.ts` branches put a bare code there and say the
 *     rest with `extra` instead of a sentence (`task_not_found` with
 *     `task_id`, `parent_not_found` with `agent_id`). Routing those
 *     through {@link toolError} would have to invent a `message` they
 *     never had.
 *
 * Either way this reproduces the existing envelope exactly. New coded
 * failures should prefer {@link toolError}, which gives the agent a
 * stable code *and* the human a sentence.
 */
export function toolErrorMessage(
  message: string,
  extra: Record<string, unknown> = {},
): AgentToolResult {
  return { content: { error: message, ...extra }, isError: true };
}
