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
    const makeMemoryAgent = vi.fn(() => memoryAgent);

    const result = await buildInstructions(
      { source: "agent", agentId: "agent_a", hierarchyLevel: "team" },
      { makeMemoryAgent },
    );

    expect(result).toBe("");
    // Agent-source path shouldn't even build a memory agent.
    expect(makeMemoryAgent).not.toHaveBeenCalled();
  });

  it("returns full briefing for human callers via prepareBriefing", async () => {
    const briefing =
      "<core_memory>\n  <block name=\"persona\">You are Alice's team agent.</block>\n</core_memory>";
    const memoryAgent = fakeMemoryAgent(briefing);
    const makeMemoryAgent = vi.fn(() => memoryAgent);

    const result = await buildInstructions(
      { source: "human", agentId: "agent_b", hierarchyLevel: "team", personId: "p1" },
      { makeMemoryAgent },
    );

    expect(result).toBe(briefing);
    expect(makeMemoryAgent).toHaveBeenCalledWith("agent_b");
    expect(memoryAgent.prepareBriefing).toHaveBeenCalledWith("(interactive)");
  });
});
