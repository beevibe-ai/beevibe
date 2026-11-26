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
 * Wrap a tool handler so anything it throws becomes the catch-all error
 * envelope rather than escaping into the MCP server.
 *
 * Every handler in `hierarchy.ts` and `mesh.ts` opened with the same
 * `try` / `catch (err) { return toolErrorFromThrown(err) }` frame — 21
 * byte-identical copies, which is 21 chances to add a tool and forget the
 * frame. A handler that throws past the MCP server surfaces to the agent
 * as a transport error instead of a readable tool result, so the frame is
 * load-bearing rather than defensive decoration.
 *
 * Handlers needing more than the catch-all keep their own `try`: the
 * `revise_task` handler maps `InvalidTaskTransitionError` to a coded
 * result first, and is deliberately left unwrapped.
 */
export function safeHandler(
  handler: (input: Record<string, unknown>) => Promise<AgentToolResult>,
): (input: Record<string, unknown>) => Promise<AgentToolResult> {
  return async (input) => {
    try {
      return await handler(input);
    } catch (err) {
      return toolErrorFromThrown(err);
    }
  };
}
