import { describe, expect, it, vi } from "vitest";
import type { FactStore } from "@beevibe/core/services/memory";
import type { MemoryFact } from "@beevibe/core";
import { createSaveMemoryTool } from "./save-memory.js";

function fakeFactStore(): { factStore: FactStore; calls: Array<{ args: unknown[] }> } {
  const calls: Array<{ args: unknown[] }> = [];
  const factStore = {
    addOrMerge: vi.fn(async (...args: unknown[]) => {
      calls.push({ args });
      return {
        id: "fact_minted",
        agent_id: args[0],
        scope: args[4],
        category: "archival",
        fact_type: args[3],
        content: args[2],
        source_session_ids: [args[1]],
      } as unknown as MemoryFact;
    }),
  } as unknown as FactStore;
  return { factStore, calls };
}

describe("save_memory tool", () => {
  it("delegates to factStore.addOrMerge with caller agentId + sessionId from context", async () => {
    const { factStore, calls } = fakeFactStore();
    const tool = createSaveMemoryTool(
      { agentId: "agent_a", sessionId: "sess_1", hierarchyLevel: "ic" },
      { factStore },
    );

    const result = await tool.handler({
      content: "Prefers pnpm over npm.",
      fact_type: "preference",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "agent_a",
      "sess_1",
      "Prefers pnpm over npm.",
      "preference",
      "ic",
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({
      saved: true,
      fact_id: "fact_minted",
      fact_type: "preference",
      scope: "ic",
    });
  });

  it("passes the caller's hierarchyLevel through as the fact scope", async () => {
    const { factStore, calls } = fakeFactStore();
    const tool = createSaveMemoryTool(
      { agentId: "agent_team", sessionId: "sess_1", hierarchyLevel: "team" },
      { factStore },
    );

    await tool.handler({
      content: "Team-wide convention: branch names use kebab-case.",
      fact_type: "pattern",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[4]).toBe("team");
  });

  it("returns isError for empty content", async () => {
    const { factStore, calls } = fakeFactStore();
    const tool = createSaveMemoryTool(
      { agentId: "agent_a", sessionId: "sess_1", hierarchyLevel: "ic" },
      { factStore },
    );

    const result = await tool.handler({ content: "   ", fact_type: "belief" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_content" });
    expect(calls).toHaveLength(0);
  });

  it("returns isError for unknown fact_type", async () => {
    const { factStore, calls } = fakeFactStore();
    const tool = createSaveMemoryTool(
      { agentId: "agent_a", sessionId: "sess_1", hierarchyLevel: "ic" },
      { factStore },
    );

    const result = await tool.handler({ content: "x", fact_type: "rumor" });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_fact_type" });
    expect(calls).toHaveLength(0);
  });

  it("tool descriptor exposes JSON schema with required fields", () => {
    const { factStore } = fakeFactStore();
    const tool = createSaveMemoryTool(
      { agentId: "agent_a", sessionId: "sess_1", hierarchyLevel: "ic" },
      { factStore },
    );

    expect(tool.name).toBe("save_memory");
    expect(tool.schema.required).toEqual(["content", "fact_type"]);
  });
});
