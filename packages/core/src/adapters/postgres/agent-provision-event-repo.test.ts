import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import { agentId, agentProvisionEventId, personId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresAgentProvisionEventRepository } from "./agent-provision-event-repo.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";

describe("PostgresAgentProvisionEventRepository", () => {
  let pool: Pool;
  let events: PostgresAgentProvisionEventRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let ownerId: string;
  let parentId: string;

  beforeAll(() => {
    pool = createTestPool();
    events = new PostgresAgentProvisionEventRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Owner" });
    ownerId = owner.id;
    parentId = (await newAgent("Parent", "team")).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  const newAgent = (name: string, level: "ic" | "team" | "org" = "ic") =>
    agents.create({
      id: agentId(),
      name,
      owner_id: ownerId,
      hierarchy_level: level,
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });

  /** Append one event for `parentId`, minting a fresh child agent for it. */
  async function record(
    opts: { parent?: string; childName?: string; createdAt?: Date } = {},
  ) {
    const child = await newAgent(opts.childName ?? "Child");
    return events.create({
      id: agentProvisionEventId(),
      parent_agent_id: opts.parent ?? parentId,
      child_agent_id: child.id,
      owner_person_id: ownerId,
      child_name: child.name,
      persona: "A careful specialist",
      domain: "backend",
      ...(opts.createdAt ? { created_at: opts.createdAt } : {}),
    });
  }

  it("create round-trips every column and defaults created_at to now()", async () => {
    const before = Date.now();
    const created = await record({ childName: "Scout" });

    expect(created.parent_agent_id).toBe(parentId);
    expect(created.owner_person_id).toBe(ownerId);
    expect(created.child_name).toBe("Scout");
    expect(created.persona).toBe("A careful specialist");
    expect(created.domain).toBe("backend");
    // COALESCE($8, NOW()) — the omitted created_at falls back to the
    // server clock, not to null.
    expect(created.created_at).toBeInstanceOf(Date);
    expect(created.created_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("create honors an explicit created_at", async () => {
    const stamp = new Date("2024-03-01T12:00:00.000Z");
    const created = await record({ createdAt: stamp });
    expect(created.created_at.toISOString()).toBe(stamp.toISOString());
  });

  it("countByParentSince counts only rows inside the window", async () => {
    await record({ childName: "Recent" });
    // Two days old — outside a 24h window, inside a 7-day one.
    await record({
      childName: "Stale",
      createdAt: new Date(Date.now() - 2 * 24 * 3600 * 1000),
    });

    expect(await events.countByParentSince(parentId, 24 * 3600)).toBe(1);
    expect(await events.countByParentSince(parentId, 7 * 24 * 3600)).toBe(2);
  });

  it("countByParentSince scopes to the parent and returns 0 for a stranger", async () => {
    await record();
    const other = await newAgent("OtherParent", "team");
    await record({ parent: other.id });

    expect(await events.countByParentSince(parentId, 3600)).toBe(1);
    expect(await events.countByParentSince(other.id, 3600)).toBe(1);
    expect(await events.countByParentSince("agent_nobody", 3600)).toBe(0);
  });

  it("listByParent returns newest first, scoped to the parent", async () => {
    const oldest = await record({
      childName: "First",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    const newest = await record({
      childName: "Second",
      createdAt: new Date("2024-06-01T00:00:00.000Z"),
    });
    const other = await newAgent("OtherParent", "team");
    await record({ parent: other.id, childName: "NotMine" });

    const list = await events.listByParent(parentId);
    expect(list.map((e) => e.id)).toEqual([newest.id, oldest.id]);
    expect(list.map((e) => e.child_name)).toEqual(["Second", "First"]);
  });

  it("listByParent respects an explicit limit", async () => {
    await record({ createdAt: new Date("2024-01-01T00:00:00.000Z") });
    await record({ createdAt: new Date("2024-02-01T00:00:00.000Z") });
    await record({ createdAt: new Date("2024-03-01T00:00:00.000Z") });

    expect(await events.listByParent(parentId, 2)).toHaveLength(2);
    expect(await events.listByParent(parentId)).toHaveLength(3);
    expect(await events.listByParent("agent_nobody")).toEqual([]);
  });
});
