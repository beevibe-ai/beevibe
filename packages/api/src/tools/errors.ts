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
 * Route anything thrown out of a tool's handler through
 * {@link toolErrorFromThrown}, for every tool in a builder's output.
 *
 * Each of the 22 hierarchy and mesh tools used to open its handler with
 * `try {` and close it with the same three lines:
 *
 * ```ts
 * } catch (err) {
 *   return toolErrorFromThrown(err);
 * }
 * ```
 *
 * That is not merely noise. The guard is what preserves a
 * {@link CodedMeshError}'s `code` and `meta` — the fields agents branch
 * on. Without it a throw escapes to the MCP transport's generic catch in
 * `routes/mcp.ts`, which flattens everything to `{ error: <message> }`,
 * so a coded mesh failure arrives at the agent indistinguishable from an
 * unexpected crash. Leaving the guard per-handler meant every new tool
 * had to remember it, and forgetting was silent.
 *
 * Applying it at the builder boundary instead makes it structural: a tool
 * handed back by `buildHierarchyTools` / `buildIcMeshTools` /
 * `buildTeamMeshTools` is guarded because it came from there, not because
 * someone typed the wrapper again.
 *
 * Handlers that *return* an error envelope are untouched — this only
 * catches throws. Wrapping twice is harmless (the inner guard wins), so
 * a tool that keeps its own `try` for local recovery still composes.
 */
export function guardToolHandlers(tools: AgentTool[]): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    handler: async (input: Record<string, unknown>) => {
      try {
        return await tool.handler(input);
      } catch (err) {
        return toolErrorFromThrown(err);
      }
    },
  }));
}
