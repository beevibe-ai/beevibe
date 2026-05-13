import { describe, expect, it, vi } from "vitest";
import type { CoreMemory } from "@beevibe/core/services/memory";
import type { CoreMemoryBlock } from "@beevibe/core";
import { createUpdateCoreMemoryTool } from "./update-core-memory.js";

function fakeCoreMemory(): { coreMemory: CoreMemory; calls: Array<{ args: unknown[] }> } {
  const calls: Array<{ args: unknown[] }> = [];
  const coreMemory = {
    applyUpdate: vi.fn(async (...args: unknown[]) => {
      calls.push({ args });
      return {
        block_name: args[1],
        agent_id: args[0],
        content: typeof args[3] === "string" ? args[3] : "",
      } as unknown as CoreMemoryBlock;
    }),
  } as unknown as CoreMemory;
  return { coreMemory, calls };
}

describe("update_core_memory tool", () => {
  it("delegates an append operation to coreMemory.applyUpdate", async () => {
    const { coreMemory, calls } = fakeCoreMemory();
    const tool = createUpdateCoreMemoryTool({ agentId: "agent_a", hierarchyLevel: "ic" }, { coreMemory });

    const result = await tool.handler({
      block_name: "persona",
      operation: "append",
      content: "I prefer terse explanations.",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "agent_a",
      "persona",
      "append",
      "I prefer terse explanations.",
      undefined,
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatchObject({ updated: true, block_name: "persona" });
  });

  it("delegates a replace operation with old_content", async () => {
    const { coreMemory, calls } = fakeCoreMemory();
    const tool = createUpdateCoreMemoryTool({ agentId: "agent_a", hierarchyLevel: "ic" }, { coreMemory });

    const result = await tool.handler({
      block_name: "domain",
      operation: "replace",
      content: "Postgres + pgvector",
      old_content: "Postgres",
    });

    expect(calls[0]?.args).toEqual([
      "agent_a",
      "domain",
      "replace",
      "Postgres + pgvector",
      "Postgres",
    ]);
    expect(result.isError).toBeFalsy();
  });

  it("rejects replace without old_content", async () => {
    const { coreMemory, calls } = fakeCoreMemory();
    const tool = createUpdateCoreMemoryTool({ agentId: "agent_a", hierarchyLevel: "ic" }, { coreMemory });

    const result = await tool.handler({
      block_name: "domain",
      operation: "replace",
      content: "X",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "missing_old_content" });
    expect(calls).toHaveLength(0);
  });

  it("rejects unknown operation", async () => {
    const { coreMemory, calls } = fakeCoreMemory();
    const tool = createUpdateCoreMemoryTool({ agentId: "agent_a", hierarchyLevel: "ic" }, { coreMemory });

    const result = await tool.handler({
      block_name: "persona",
      operation: "delete",
      content: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "invalid_operation" });
    expect(calls).toHaveLength(0);
  });

  it("surfaces service errors as isError responses", async () => {
    const coreMemory = {
      applyUpdate: vi.fn(async () => {
        throw new Error("Block \"persona\" not found for agent agent_a — initDefaults first");
      }),
    } as unknown as CoreMemory;
    const tool = createUpdateCoreMemoryTool({ agentId: "agent_a", hierarchyLevel: "ic" }, { coreMemory });

    const result = await tool.handler({
      block_name: "persona",
      operation: "append",
      content: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "update_failed" });
    expect(String((result.content as { message: string }).message)).toMatch(/not found/);
  });

  it("rejects block_name not in the agent's tier template", async () => {
    const { coreMemory } = fakeCoreMemory();
    const tool = createUpdateCoreMemoryTool({ agentId: "agent_a", hierarchyLevel: "ic" }, { coreMemory });
    const result = await tool.handler({
      block_name: "team_members",
      operation: "append",
      content: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatchObject({ error: "unknown_block" });
  });

  it("tool descriptor exposes JSON schema with required fields", () => {
    const { coreMemory } = fakeCoreMemory();
    const tool = createUpdateCoreMemoryTool({ agentId: "agent_a", hierarchyLevel: "ic" }, { coreMemory });
    expect(tool.name).toBe("update_core_memory");
    expect(tool.schema.required).toEqual(["block_name", "operation", "content"]);
  });
});
