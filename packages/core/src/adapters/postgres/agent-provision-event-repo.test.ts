import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import { agentId, agentProvisionEventId, personId } from "../../domain/ids.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import type { Pool } from "./client.js";
import { PostgresAgentProvisionEventRepository } from "./agent-provision-event-repo.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";

/**
 * `agent_provision_event` is the audit trail behind
 * `create_subordinate_agent`. Its write side is live and accumulating
 * rows, and `countByParentSince` is what enforces the per-parent spawn
 * cap — a window query that silently counting wrong would either let a
 * runaway parent spawn without limit or lock out a legitimate one.
 * These tests pin the roundtrip, the time window, and the read halves
 * the audit panel will consume.
 */
describe("PostgresAgentProvisionEventRepository", () => {
  let pool: Pool;
  let events: PostgresAgentProvisionEventRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;

  let owner: string;
  let parent: string;
  let child: string;

  beforeAll(() => {
    pool = createTestPool();
    events = new PostgresAgentProvisionEventRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const person = await persons.create({ id: personId(), name: "Owner" });
    owner = person.id;
    const p = await agents.create({
      id: agentId(),
      name: "Parent",
      owner_id: owner,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    parent = p.id;
    const c = await agents.create({
      id: agentId(),
      name: "Child",
      owner_id: owner,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    child = c.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedEvent(overrides: { parent?: string; createdAt?: Date } = {}) {
    return events.create({
      id: agentProvisionEventId(),
      parent_agent_id: overrides.parent ?? parent,
      child_agent_id: child,
      owner_person_id: owner,
      child_name: "Child",
      persona: "A careful reviewer.",
      domain: "code-review",
      ...(overrides.createdAt ? { created_at: overrides.createdAt } : {}),
    });
  }

  it("create returns the persisted row with every field intact", async () => {
    const created = await seedEvent();

    expect(created).toMatchObject({
      parent_agent_id: parent,
      child_agent_id: child,
      owner_person_id: owner,
      child_name: "Child",
      persona: "A careful reviewer.",
      domain: "code-review",
    });
    expect(created.id).toMatch(/^ape_/);
    expect(created.created_at).toBeInstanceOf(Date);
  });

  it("defaults created_at to now when the caller omits it", async () => {
    const before = Date.now();
    const created = await seedEvent();

    // A second of slack absorbs clock skew between the test process and
    // the database server.
    expect(created.created_at.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(created.created_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("honours an explicit created_at so backfills keep their timestamps", async () => {
    const stamped = new Date("2026-03-04T05:06:07.000Z");

    const created = await seedEvent({ createdAt: stamped });

    expect(created.created_at.toISOString()).toBe(stamped.toISOString());
  });

  describe("countByParentSince", () => {
    it("counts only events inside the window", async () => {
      const now = Date.now();
      await seedEvent({ createdAt: new Date(now - 30 * 1000) }); // inside
      await seedEvent({ createdAt: new Date(now - 90 * 1000) }); // outside
      await seedEvent({ createdAt: new Date(now - 10 * 1000) }); // inside

      expect(await events.countByParentSince(parent, 60)).toBe(2);
      expect(await events.countByParentSince(parent, 3600)).toBe(3);
    });

    it("scopes the count to one parent", async () => {
      const other = await agents.create({
        id: agentId(),
        name: "Other parent",
        owner_id: owner,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      });
      await seedEvent();
      await seedEvent({ parent: other.id });

      expect(await events.countByParentSince(parent, 3600)).toBe(1);
      expect(await events.countByParentSince(other.id, 3600)).toBe(1);
    });

    it("returns 0 for a parent that never spawned anything", async () => {
      expect(await events.countByParentSince(parent, 86_400)).toBe(0);
    });
  });

  describe("listByParent", () => {
    it("returns the parent's events newest first", async () => {
      const now = Date.now();
      const oldest = await seedEvent({ createdAt: new Date(now - 3_000) });
      const middle = await seedEvent({ createdAt: new Date(now - 2_000) });
      const newest = await seedEvent({ createdAt: new Date(now - 1_000) });

      const listed = await events.listByParent(parent);

      expect(listed.map((e) => e.id)).toEqual([newest.id, middle.id, oldest.id]);
    });

    it("caps at the supplied limit, and at 50 by default", async () => {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        await seedEvent({ createdAt: new Date(now - i * 1_000) });
      }

      expect(await events.listByParent(parent, 2)).toHaveLength(2);
      expect(await events.listByParent(parent)).toHaveLength(3);
    });

    it("returns an empty list for an unknown parent", async () => {
      expect(await events.listByParent("agent_nosuchagent")).toEqual([]);
    });
  });
});
