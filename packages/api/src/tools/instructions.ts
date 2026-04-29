import type { ResolvedCaller } from "@beevibe/core/auth";
import type { MemoryAgent } from "@beevibe/core/services/memory";

export interface BuildInstructionsServices {
  /**
   * Per-agent MemoryAgent factory. The composition root closes over
   * shared memory services (FactStore, CoreMemory, FactPromoter, embed)
   * and produces a fresh agent-scoped instance.
   */
  makeMemoryAgent: (agentId: string) => MemoryAgent;
}

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
 */
export async function buildInstructions(
  caller: ResolvedCaller,
  services: BuildInstructionsServices,
): Promise<string> {
  if (caller.source === "agent") {
    return "";
  }
  const memoryAgent = services.makeMemoryAgent(caller.agentId);
  return memoryAgent.prepareBriefing("(interactive)");
}
