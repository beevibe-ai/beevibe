import type { AgentRepository } from "@beevibe/core";
import {
  composeSystemPromptAppend,
  teamAgentRoutingDirective,
} from "@beevibe/core/services/agent-session";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import type { McpCaller } from "./assemble.js";

/**
 * Build the MCP `instructions` string returned on `initialize`.
 *
 * Branch on `caller.source`:
 *   - "agent" → empty string. The agent's CLI was spawned by the executor
 *     (or a mesh tool handler), which already injected the full prompt
 *     stack via `--append-system-prompt` (system) + intent prefix (user).
 *     Duplicating either as `instructions` would waste tokens.
 *   - "human" → the team agent's full chat-flavored prompt stack
 *     (lifecycle reminder, memory reminder, team_agent_routing,
 *     per-agent baseline, core_memory). The human's local CLI consumes
 *     the team agent's identity over MCP, so we ship the same prompt
 *     content a team chat session would get — minus the beevibe chat UI
 *     grammar (the local CLI can't render our suggest_action chips) and
 *     minus archival memory (no intent yet — the CLI uses
 *     `search_context` on demand instead).
 */
export async function buildInstructions(
  caller: McpCaller,
  memoryAgent: MemoryAgent,
  agentRepo: AgentRepository,
): Promise<string> {
  if (caller.source === "agent") {
    return "";
  }
  const [briefing, agent, subordinates] = await Promise.all([
    memoryAgent.prepareCoreOnly(),
    agentRepo.findById(caller.agentId),
    caller.hierarchyLevel === "team"
      ? agentRepo.findSubordinates(caller.agentId)
      : Promise.resolve([]),
  ]);
  const teamRouting =
    caller.hierarchyLevel === "team"
      ? teamAgentRoutingDirective(subordinates.map((s) => s.name))
      : "";
  return composeSystemPromptAppend(
    agent?.runtime_config.system_prompt_addition,
    briefing.systemPromptAppend,
    { sessionKind: "human_mcp", extra: teamRouting },
  );
}
