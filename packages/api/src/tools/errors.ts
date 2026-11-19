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
 * Wrap a tool so a throw out of its handler becomes a
 * {@link toolErrorFromThrown} envelope instead of escaping.
 *
 * Applied once by `assembleTools`, so this is a property of being a
 * Beevibe tool rather than something each tool has to remember. It used to
 * be the latter, and the result was uneven: 21 handlers opened with
 * `try {` and closed with an identical `catch (err) { return
 * toolErrorFromThrown(err); }`, while `find_repo`, `save_memory`,
 * `update_core_memory` and `use_repo` had no catch at all.
 *
 * The four uncaught ones didn't crash — every call site
 * (`routes/mcp.ts`, `routes/capabilities.ts`, `routes/find-repo.ts`,
 * `sandbox/mcp-server.ts`) has its own outer catch. But those catches
 * flatten a throw to `{ error: <message> }`, which silently drops the
 * `code` and `meta` of a {@link CodedMeshError} — the whole reason for
 * raising one, since agents branch on `error`. So a mesh failure surfaced
 * as a stable code through 25 tools and as prose through four, depending
 * on which tool you happened to be calling.
 *
 * Wrapping is safe for a handler that already catches: its own catch runs
 * first and this one never sees the error. That makes the inner copies
 * redundant rather than conflicting, which is why they could be removed
 * in the same change. Handlers that map *specific* error classes to
 * specific codes (`watch`, `session_search`, `revise_task`) keep their
 * catch — this wrapper is their fallthrough, not their replacement.
 */
export function withToolErrors(tool: AgentTool): AgentTool {
  return {
    ...tool,
    handler: async (input) => {
      try {
        return await tool.handler(input);
      } catch (err) {
        return toolErrorFromThrown(err);
      }
    },
  };
}
