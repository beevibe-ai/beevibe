import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG, type HierarchyLevel } from "../../domain/agent.js";
import { agentId, personId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";

describe("PostgresAgentRepository", () => {
  let pool: Pool;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let ownerId: string;

  beforeAll(() => {
    pool = createTestPool();
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Owner" });
    ownerId = owner.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  const newAgent = (overrides: Partial<Parameters<typeof agents.create>[0]> = {}) => ({
    id: agentId(),
    name: "Agent",
    owner_id: ownerId,
    hierarchy_level: "ic" as HierarchyLevel,
    runtime_config: DEFAULT_RUNTIME_CONFIG,
    ...overrides,
  });

  it("create + findById round-trips with null-like fields mapped to undefined", async () => {
    const id = agentId();
    const created = await agents.create(newAgent({ id, name: "Dan" }));
    expect(created.id).toBe(id);
    expect(created.name).toBe("Dan");
    expect(created.owner_id).toBe(ownerId);
    expect(created.parent_agent_id).toBeUndefined();
    expect(created.api_key).toBeUndefined();
    expect(created.review_policy).toBeUndefined();
    expect(created.runtime_config.type).toBe("claude");

    const found = await agents.findById(id);
    expect(found).toEqual(created);
  });

  it("findByApiKey hits the partial unique index", async () => {
    const a1 = await agents.create(newAgent({ api_key: "bv_aaa" }));
    await agents.create(newAgent()); // no api_key
    const found = await agents.findByApiKey("bv_aaa");
    expect(found?.id).toBe(a1.id);
  });

  it("api_key UNIQUE constraint prevents duplicates", async () => {
    await agents.create(newAgent({ api_key: "bv_dup" }));
    await expect(agents.create(newAgent({ api_key: "bv_dup" }))).rejects.toThrow();
  });

  it("findTopLevelForOwner returns team agent over org", async () => {
    await agents.create(newAgent({ hierarchy_level: "ic" }));
    await agents.create(newAgent({ hierarchy_level: "org", name: "org-a" }));
    const team = await agents.create(newAgent({ hierarchy_level: "team", name: "team-a" }));
    const top = await agents.findTopLevelForOwner(ownerId);
    expect(top?.id).toBe(team.id);
  });

  it("findTopLevelForOwner falls back to org when no team exists", async () => {
    await agents.create(newAgent({ hierarchy_level: "ic" }));
    const org = await agents.create(newAgent({ hierarchy_level: "org" }));
    const top = await agents.findTopLevelForOwner(ownerId);
    expect(top?.id).toBe(org.id);
  });

  it("findTopLevelForOwner returns undefined when only IC exists", async () => {
    await agents.create(newAgent({ hierarchy_level: "ic" }));
    expect(await agents.findTopLevelForOwner(ownerId)).toBeUndefined();
  });

  it("findSubordinates returns direct children only, sorted by name", async () => {
    const parent = await agents.create(newAgent({ hierarchy_level: "team", name: "parent" }));
    const child1 = await agents.create(newAgent({ parent_agent_id: parent.id, name: "zeta" }));
    const child2 = await agents.create(newAgent({ parent_agent_id: parent.id, name: "alpha" }));
    await agents.create(newAgent({ name: "unrelated" })); // different parent (undefined)

    const subs = await agents.findSubordinates(parent.id);
    expect(subs.map((a) => a.id)).toEqual([child2.id, child1.id]);
  });

  it("findPeers returns same-level + same-parent, excluding self", async () => {
    const parent = await agents.create(newAgent({ hierarchy_level: "team", name: "parent" }));
    const peerA = await agents.create(newAgent({ parent_agent_id: parent.id, name: "peer-a" }));
    const peerB = await agents.create(newAgent({ parent_agent_id: parent.id, name: "peer-b" }));
    await agents.create(newAgent({ name: "outsider" })); // no parent

    const peersOfA = await agents.findPeers(peerA.id);
    expect(peersOfA.map((a) => a.id)).toEqual([peerB.id]);
  });

  it("findParent returns the direct parent", async () => {
    const parent = await agents.create(newAgent({ hierarchy_level: "team", name: "parent" }));
    const child = await agents.create(
      newAgent({ parent_agent_id: parent.id, hierarchy_level: "ic", name: "child" }),
    );

    const found = await agents.findParent(child.id);
    expect(found?.id).toBe(parent.id);
  });

  it("findParent returns undefined for top-level agents", async () => {
    const top = await agents.create(newAgent({ hierarchy_level: "team", name: "top" }));
    const found = await agents.findParent(top.id);
    expect(found).toBeUndefined();
  });

  it("findParent returns undefined for unknown agent id", async () => {
    const found = await agents.findParent("agent_nonexistent_xxx");
    expect(found).toBeUndefined();
  });

  it("findByLevel returns all agents at that level", async () => {
    const t1 = await agents.create(newAgent({ hierarchy_level: "team", name: "t1" }));
    const t2 = await agents.create(newAgent({ hierarchy_level: "team", name: "t2" }));
    await agents.create(newAgent({ hierarchy_level: "ic", name: "ic1" }));

    const teams = await agents.findByLevel("team");
    expect(teams.map((a) => a.id).sort()).toEqual([t1.id, t2.id].sort());
  });

  it("update patches selective fields only", async () => {
    const a = await agents.create(newAgent({ name: "Before", max_task_sessions: 1 }));
    const updated = await agents.update(a.id, { name: "After", max_task_sessions: 5 });
    expect(updated.name).toBe("After");
    expect(updated.max_task_sessions).toBe(5);
    expect(updated.owner_id).toBe(a.owner_id); // untouched
  });

  it("update can nullify optional fields by passing undefined sentinel", async () => {
    const a = await agents.create(newAgent({ api_key: "bv_x" }));
    expect(a.api_key).toBe("bv_x");
    // Patch explicit undefined — no-op (undefined means "don't touch" in our patch semantics)
    const noChange = await agents.update(a.id, { api_key: undefined });
    expect(noChange.api_key).toBe("bv_x");
  });

  it("update runtime_config JSONB round-trips the object", async () => {
    const a = await agents.create(newAgent());
    const newConfig = { type: "claude" as const, model: "claude-sonnet-4-6", max_turns: 12 };
    const updated = await agents.update(a.id, { runtime_config: newConfig });
    expect(updated.runtime_config.model).toBe("claude-sonnet-4-6");
    expect(updated.runtime_config.max_turns).toBe(12);
  });

  it("delete removes the row (cascade picks up blocks in later tests)", async () => {
    const a = await agents.create(newAgent());
    await agents.delete(a.id);
    expect(await agents.findById(a.id)).toBeUndefined();
  });

  it("FK to person is enforced — missing owner rejects", async () => {
    await expect(
      agents.create(newAgent({ owner_id: "person_missing" })),
    ).rejects.toThrow();
  });

  it("FK to parent_agent self-reference works", async () => {
    const parent = await agents.create(newAgent({ hierarchy_level: "team" }));
    const child = await agents.create(newAgent({ parent_agent_id: parent.id }));
    expect(child.parent_agent_id).toBe(parent.id);
  });
});
