import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import { DEFAULT_BLOCK_TEMPLATES } from "../../domain/core-memory.js";
import { agentId, blockId, personId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresCoreMemoryRepository } from "./core-memory-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";

describe("PostgresCoreMemoryRepository", () => {
  let pool: Pool;
  let blocks: PostgresCoreMemoryRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let agent1Id: string;

  beforeAll(() => {
    pool = createTestPool();
    blocks = new PostgresCoreMemoryRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Owner" });
    const agent = await agents.create({
      id: agentId(),
      name: "A",
      owner_id: owner.id,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    agent1Id = agent.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("upsert creates a new block", async () => {
    const b = await blocks.upsert({
      id: blockId(),
      agent_id: agent1Id,
      block_name: "persona",
      content: "I am a test agent",
      char_limit: 500,
      is_system: true,
    });
    expect(b.block_name).toBe("persona");
    expect(b.content).toBe("I am a test agent");
  });

  it("upsert updates content + char_limit when row exists (ON CONFLICT branch)", async () => {
    const originalId = blockId();
    await blocks.upsert({
      id: originalId,
      agent_id: agent1Id,
      block_name: "persona",
      content: "v1",
      char_limit: 500,
      is_system: true,
    });
    const updated = await blocks.upsert({
      id: blockId(), // different id — ignored, existing row's id preserved
      agent_id: agent1Id,
      block_name: "persona",
      content: "v2",
      char_limit: 1000,
      is_system: true,
    });
    expect(updated.id).toBe(originalId);
    expect(updated.content).toBe("v2");
    expect(updated.char_limit).toBe(1000);
  });

  it("findByAgent returns all blocks for an agent, sorted", async () => {
    await blocks.upsert({
      id: blockId(),
      agent_id: agent1Id,
      block_name: "zulu",
      content: "z",
      char_limit: 100,
      is_system: true,
    });
    await blocks.upsert({
      id: blockId(),
      agent_id: agent1Id,
      block_name: "alpha",
      content: "a",
      char_limit: 100,
      is_system: true,
    });
    const all = await blocks.findByAgent(agent1Id);
    expect(all.map((b) => b.block_name)).toEqual(["alpha", "zulu"]);
  });

  it("findOne returns undefined for missing (agent, block)", async () => {
    const found = await blocks.findOne(agent1Id, "missing");
    expect(found).toBeUndefined();
  });

  it("updateContent updates existing block and bumps updated_at", async () => {
    const b = await blocks.upsert({
      id: blockId(),
      agent_id: agent1Id,
      block_name: "persona",
      content: "original",
      char_limit: 500,
      is_system: true,
    });
    const originalUpdated = b.updated_at.getTime();
    await new Promise((r) => setTimeout(r, 10));
    const updated = await blocks.updateContent(agent1Id, "persona", "changed");
    expect(updated.content).toBe("changed");
    expect(updated.updated_at.getTime()).toBeGreaterThan(originalUpdated);
  });

  it("updateContent throws when block doesn't exist", async () => {
    await expect(blocks.updateContent(agent1Id, "nope", "x")).rejects.toThrow(/not found/);
  });

  it("delete removes a specific block", async () => {
    await blocks.upsert({
      id: blockId(),
      agent_id: agent1Id,
      block_name: "persona",
      content: "",
      char_limit: 500,
      is_system: true,
    });
    await blocks.delete(agent1Id, "persona");
    expect(await blocks.findOne(agent1Id, "persona")).toBeUndefined();
  });

  it("initDefaults creates the IC block template set", async () => {
    const created = await blocks.initDefaults(agent1Id, "ic");
    const names = created.map((b) => b.block_name).sort();
    const expected = DEFAULT_BLOCK_TEMPLATES.ic.map((t) => t.block_name).sort();
    expect(names).toEqual(expected);
  });

  it("initDefaults creates the team block template set", async () => {
    const created = await blocks.initDefaults(agent1Id, "team");
    const names = created.map((b) => b.block_name).sort();
    const expected = DEFAULT_BLOCK_TEMPLATES.team.map((t) => t.block_name).sort();
    expect(names).toEqual(expected);
  });

  it("deleting agent cascades to blocks (FK ON DELETE CASCADE)", async () => {
    await blocks.initDefaults(agent1Id, "ic");
    expect((await blocks.findByAgent(agent1Id)).length).toBeGreaterThan(0);
    await agents.delete(agent1Id);
    expect(await blocks.findByAgent(agent1Id)).toEqual([]);
  });

  it("UNIQUE(agent_id, block_name) permits same block_name across agents", async () => {
    const owner = await persons.create({ id: personId(), name: "Other" });
    const agent2 = await agents.create({
      id: agentId(),
      name: "B",
      owner_id: owner.id,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    await blocks.upsert({
      id: blockId(),
      agent_id: agent1Id,
      block_name: "persona",
      content: "a1",
      char_limit: 500,
      is_system: true,
    });
    await blocks.upsert({
      id: blockId(),
      agent_id: agent2.id,
      block_name: "persona",
      content: "a2",
      char_limit: 500,
      is_system: true,
    });
    const a1 = await blocks.findOne(agent1Id, "persona");
    const a2 = await blocks.findOne(agent2.id, "persona");
    expect(a1?.content).toBe("a1");
    expect(a2?.content).toBe("a2");
  });
});
