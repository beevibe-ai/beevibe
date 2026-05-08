import type { MemoryAgent } from "@beevibe/core/services/memory";
import type { McpCaller } from "./assemble.js";

/**
 * Build the MCP `instructions` string returned on `initialize`.
 *
 * Branch on `caller.source`:
 *   - "agent" → empty string. The agent's CLI was spawned by the executor
 *     (or a mesh tool handler), which already injected the briefing via
 *     `--append-system-prompt` (system) + intent prefix (user) — duplicating
 *     either as `instructions` would waste tokens.
 *   - "human" → full briefing (BOTH halves joined). The user ran `claude`
 *     themselves; no system-prompt arg was passed and no way to prepend to
 *     their first user message, so we deliver everything through the MCP
 *     `instructions` field. M9.4's split-by-stability optimization is
 *     agent-only — humans get the consolidated briefing because their path
 *     can't host the per-message prefix.
 *
 * Takes the already-built `MemoryAgent` (constructed once per session at
 * the call site) rather than the factory — avoids rebuilding it just to
 * call `prepareBriefing`.
 */
export async function buildInstructions(
  caller: McpCaller,
  memoryAgent: MemoryAgent,
): Promise<string> {
  if (caller.source === "agent") {
    return "";
  }
  const briefing = await memoryAgent.prepareBriefing("(interactive)");
  // Join system + user halves with a blank line so the human's session sees
  // both core_memory and archival_memory contextually adjacent in the
  // initial system prompt.
  return [briefing.systemPromptAppend, briefing.userMessagePrefix]
    .filter((s) => s.length > 0)
    .join("\n\n");
}
