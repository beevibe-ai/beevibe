import { describe, expect, it, vi } from "vitest";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import { buildInstructions } from "./instructions.js";

function fakeMemoryAgent(briefing: string): MemoryAgent {
  return {
    prepareBriefing: vi.fn(async () => briefing),
    onTaskComplete: vi.fn(async () => {}),
  };
}

describe("buildInstructions", () => {
  it("returns empty string for agent callers (briefing already in --append-system-prompt)", async () => {
    const memoryAgent = fakeMemoryAgent("<core_memory>...</core_memory>");

    const result = await buildInstructions(
      { source: "agent", agentId: "agent_a", hierarchyLevel: "team" },
      memoryAgent,
    );

    expect(result).toBe("");
    // Agent-source path shouldn't query memory.
    expect(memoryAgent.prepareBriefing).not.toHaveBeenCalled();
  });

  it("returns full briefing for human callers via prepareBriefing", async () => {
    const briefing =
      "<core_memory>\n  <block name=\"persona\">You are Alice's team agent.</block>\n</core_memory>";
    const memoryAgent = fakeMemoryAgent(briefing);

    const result = await buildInstructions(
      { source: "human", agentId: "agent_b", hierarchyLevel: "team", personId: "p1" },
      memoryAgent,
    );

    expect(result).toBe(briefing);
    expect(memoryAgent.prepareBriefing).toHaveBeenCalledWith("(interactive)");
  });
});
