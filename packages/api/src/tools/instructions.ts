import type { ResolvedCaller } from "@beevibe/core/auth";
import type { MemoryAgent } from "@beevibe/core/services/memory";

/**
 * Build the MCP `instructions` string returned on `initialize`.
 *
 * Branch on `caller.source`:
 *   - "agent" → empty string. The agent's CLI was spawned by the executor
 *     (or a mesh tool handler), which already injected the briefing via
 *     `--append-system-prompt` — duplicating it as `instructions` would
 *     waste tokens.
 *   - "human" → full briefing via `MemoryAgent.prepareBriefing("(interactive)")`.
 *     The user ran `claude` themselves; no system-prompt arg was passed, so
 *     we deliver the briefing through MCP.
 *
 * Takes the already-built `MemoryAgent` (constructed once per session at
 * the call site) rather than the factory — avoids rebuilding it just to
 * call `prepareBriefing`.
 */
export async function buildInstructions(
  caller: ResolvedCaller,
  memoryAgent: MemoryAgent,
): Promise<string> {
  if (caller.source === "agent") {
    return "";
  }
  return memoryAgent.prepareBriefing("(interactive)");
}
