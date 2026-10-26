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
import type { AgentTool, AgentToolResult } from "./types.js";

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
 * Wrap a tool handler so an unexpected throw becomes the catch-all
 * envelope instead of escaping the handler.
 *
 * Every tool needs this: `routes/mcp.ts` has its own catch around
 * `tool.handler(...)`, but that one flattens a {@link CodedMeshError} to
 * `{ error: <message> }` and loses the `code` the calling agent branches
 * on. So the shape here is not redundant with it — it is what keeps the
 * coded contract intact.
 *
 * Twenty-one handlers across `hierarchy.ts` and `mesh.ts` opened with a
 * byte-identical `try {` / `} catch (err) { return
 * toolErrorFromThrown(err); }` pair around their whole body. Lifting it
 * here leaves each handler as just its happy path, and a new tool gets
 * the envelope by construction rather than by remembering to copy four
 * lines.
 *
 * Handlers that map a *typed* error before falling through keep their own
 * `catch`: `revise_task` (InvalidTaskTransitionError), `watch.ts`
 * (`caughtError`) and `session-search.ts` (SessionSearchError) are
 * deliberately not this shape.
 */
export function guarded(handler: AgentTool["handler"]): AgentTool["handler"] {
  return async (input) => {
    try {
      return await handler(input);
    } catch (err) {
      return toolErrorFromThrown(err);
    }
  };
}
