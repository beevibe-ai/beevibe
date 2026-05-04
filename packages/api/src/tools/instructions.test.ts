import { describe, expect, it, vi } from "vitest";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import { buildInstructions } from "./instructions.js";

function fakeMemoryAgent(opts: {
  systemPromptAppend?: string;
  userMessagePrefix?: string;
}): MemoryAgent {
  return {
    prepareBriefing: vi.fn(async () => ({
      systemPromptAppend: opts.systemPromptAppend ?? "",
      userMessagePrefix: opts.userMessagePrefix ?? "",
      snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] },
    })),
    onTaskComplete: vi.fn(async () => {}),
  };
}

describe("buildInstructions", () => {
  it("returns empty string for agent callers (briefing already injected via --append-system-prompt + intent prefix)", async () => {
    const memoryAgent = fakeMemoryAgent({
      systemPromptAppend: "<core_memory>...</core_memory>",
      userMessagePrefix: "<archival_memory>...</archival_memory>",
    });

    const result = await buildInstructions(
      { source: "agent", agentId: "agent_a", hierarchyLevel: "team" },
      memoryAgent,
    );

    expect(result).toBe("");
    // Agent-source path shouldn't query memory.
    expect(memoryAgent.prepareBriefing).not.toHaveBeenCalled();
  });

  it("returns BOTH halves joined for human callers (M9.4 — humans can't host the per-message prefix)", async () => {
    const memoryAgent = fakeMemoryAgent({
      systemPromptAppend:
        '<core_memory>\n  <block name="persona">You are Alice\'s team agent.</block>\n</core_memory>',
      userMessagePrefix: "<archival_memory>\n  <fact>top-k vector hit</fact>\n</archival_memory>",
    });

    const result = await buildInstructions(
      { source: "human", agentId: "agent_b", hierarchyLevel: "team", personId: "p1" },
      memoryAgent,
    );

    // Both halves present, joined by blank line so the human's claude
    // session sees core_memory and archival_memory contextually adjacent.
    expect(result).toContain("<core_memory>");
    expect(result).toContain("<archival_memory>");
    expect(result).toContain("\n\n");
    expect(memoryAgent.prepareBriefing).toHaveBeenCalledWith("(interactive)");
  });

  it("filters out empty halves when only one is present", async () => {
    const memoryAgent = fakeMemoryAgent({
      systemPromptAppend: "<core_memory>only this</core_memory>",
      userMessagePrefix: "",
    });

    const result = await buildInstructions(
      { source: "human", agentId: "agent_c", hierarchyLevel: "ic", personId: "p1" },
      memoryAgent,
    );

    expect(result).toBe("<core_memory>only this</core_memory>");
  });
});
