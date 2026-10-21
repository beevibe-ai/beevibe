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
 * Wrap a tool definition so an exception out of its handler comes back as an
 * `AgentToolResult` rather than propagating.
 *
 * Every tool in `hierarchy.ts`, `mesh.ts` and `watch.ts` opened its handler
 * with `try {` and closed it with the same three lines — 23 copies of the
 * same envelope, and a 24th tool would have been one `try` away from
 * crashing out of the handler instead of answering. `/mcp`'s
 * `CallToolRequest` handler does catch a throw, but it flattens it to
 * `{ error: message }`, losing the code and meta a {@link CodedMeshError}
 * carries — so the per-tool envelope is load-bearing, not redundant.
 *
 * `onThrown` defaults to {@link toolErrorFromThrown}. Pass a mapper for a
 * module that narrows its own error types first (`watch.ts` maps its four
 * `Watch*Error` classes to coded results; `revise_task` maps
 * `InvalidTaskTransitionError`) — the mapper owns the whole catch, so it
 * should delegate to `toolErrorFromThrown` for anything it doesn't name.
 */
export function defineTool(
  tool: AgentTool,
  onThrown: (err: unknown) => AgentToolResult = toolErrorFromThrown,
): AgentTool {
  return {
    ...tool,
    handler: async (input) => {
      try {
        return await tool.handler(input);
      } catch (err) {
        return onThrown(err);
      }
    },
  };
}
