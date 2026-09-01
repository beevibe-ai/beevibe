/**
 * `agent_provision_event` adapter — integration tests against Postgres.
 *
 * The write half is live: `create_subordinate_agent` appends a row per
 * spawn and gates itself on `countByParentSince`. That count is a rate
 * limit, so the window arithmetic (`NOW() - N * INTERVAL '1 second'`,
 * inclusive at the boundary) is the part worth pinning — an off-by-one
 * there either lets a runaway parent spawn past its cap or locks a
 * legitimate one out. `listByParent` backs the (unbuilt) audit panel;
 * its ordering and default limit are contract too.
 */
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
    const parent = await agents.create({
      id: agentId(),
      name: "Team",
      owner_id: ownerId,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    parentId = parent.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  /** A fresh IC child under the shared parent. */
  async function makeChild(name = "Specialist"): Promise<string> {
    const child = await agents.create({
      id: agentId(),
      name,
      owner_id: ownerId,
      hierarchy_level: "ic",
      parent_agent_id: parentId,
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    return child.id;
  }

  async function record(
    opts: { parent?: string; child?: string; name?: string; at?: Date } = {},
  ) {
    return events.create({
      id: agentProvisionEventId(),
      parent_agent_id: opts.parent ?? parentId,
      child_agent_id: opts.child ?? (await makeChild(opts.name)),
      owner_person_id: ownerId,
      child_name: opts.name ?? "Specialist",
      persona: "A careful reviewer",
      domain: "code review",
      ...(opts.at ? { created_at: opts.at } : {}),
    });
  }

  it("round-trips every column on create", async () => {
    const childId = await makeChild("Reviewer");
    const id = agentProvisionEventId();
    const created = await events.create({
      id,
      parent_agent_id: parentId,
      child_agent_id: childId,
      owner_person_id: ownerId,
      child_name: "Reviewer",
      persona: "A careful reviewer",
      domain: "code review",
    });

    expect(created).toMatchObject({
      id,
      parent_agent_id: parentId,
      child_agent_id: childId,
      owner_person_id: ownerId,
      child_name: "Reviewer",
      persona: "A careful reviewer",
      domain: "code review",
    });
    expect(created.created_at).toBeInstanceOf(Date);
  });

  it("defaults created_at to now when the caller omits it", async () => {
    const before = Date.now();
    const created = await record();
    // Allow a second of clock skew between the test process and Postgres.
    expect(created.created_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(created.created_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("honors an explicit created_at (backfill path)", async () => {
    const at = new Date("2026-02-03T04:05:06.000Z");
    const created = await record({ at });
    expect(created.created_at.toISOString()).toBe(at.toISOString());
  });

  describe("countByParentSince", () => {
    it("returns 0 for a parent that has never spawned", async () => {
      expect(await events.countByParentSince(parentId, 86_400)).toBe(0);
    });

    it("counts only events inside the window", async () => {
      const now = Date.now();
      await record({ at: new Date(now - 60 * 1000) }); // 1m ago — in
      await record({ at: new Date(now - 30 * 60 * 1000) }); // 30m ago — in
      await record({ at: new Date(now - 25 * 60 * 60 * 1000) }); // 25h ago — out

      expect(await events.countByParentSince(parentId, 86_400)).toBe(2);
      expect(await events.countByParentSince(parentId, 3_600)).toBe(2);
      expect(await events.countByParentSince(parentId, 300)).toBe(1);
    });

    it("scopes the count to one parent", async () => {
      const other = await agents.create({
        id: agentId(),
        name: "Other team",
        owner_id: ownerId,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      });
      await record();
      await record();
      await record({ parent: other.id });

      expect(await events.countByParentSince(parentId, 86_400)).toBe(2);
      expect(await events.countByParentSince(other.id, 86_400)).toBe(1);
    });

    it("counts nothing for a zero-length window", async () => {
      await record({ at: new Date(Date.now() - 1_000) });
      expect(await events.countByParentSince(parentId, 0)).toBe(0);
    });
  });

  describe("listByParent", () => {
    it("returns newest first", async () => {
      const now = Date.now();
      const oldest = await record({ name: "A", at: new Date(now - 3_000) });
      const middle = await record({ name: "B", at: new Date(now - 2_000) });
      const newest = await record({ name: "C", at: new Date(now - 1_000) });

      const rows = await events.listByParent(parentId);
      expect(rows.map((r) => r.id)).toEqual([newest.id, middle.id, oldest.id]);
      expect(rows[0]?.child_name).toBe("C");
    });

    it("caps at the requested limit", async () => {
      const now = Date.now();
      await record({ at: new Date(now - 3_000) });
      await record({ at: new Date(now - 2_000) });
      const newest = await record({ at: new Date(now - 1_000) });

      const rows = await events.listByParent(parentId, 1);
      expect(rows.map((r) => r.id)).toEqual([newest.id]);
    });

    it("defaults to 50 rows", async () => {
      const child = await makeChild();
      const now = Date.now();
      for (let i = 0; i < 55; i += 1) {
        await events.create({
          id: agentProvisionEventId(),
          parent_agent_id: parentId,
          child_agent_id: child,
          owner_person_id: ownerId,
          child_name: `S${i}`,
          persona: "p",
          domain: "d",
          created_at: new Date(now - i * 1_000),
        });
      }
      expect(await events.listByParent(parentId)).toHaveLength(50);
    });

    it("returns an empty array for an unknown parent", async () => {
      await record();
      expect(await events.listByParent("agent_nonexistent")).toEqual([]);
    });
  });

  it("cascades away when the child agent is deleted", async () => {
    const childId = await makeChild();
    await record({ child: childId });
    expect(await events.countByParentSince(parentId, 86_400)).toBe(1);

    await agents.delete(childId);
    expect(await events.listByParent(parentId)).toEqual([]);
    expect(await events.countByParentSince(parentId, 86_400)).toBe(0);
  });
});
