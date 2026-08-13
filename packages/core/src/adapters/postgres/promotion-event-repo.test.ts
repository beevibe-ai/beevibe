import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import {
  agentId,
  factId,
  personId,
  promotionEventId,
  sessionId,
} from "../../domain/ids.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import type { Pool } from "./client.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresMemoryFactRepository } from "./memory-fact-repo.js";
import { PostgresMemoryPromotionEventRepository } from "./promotion-event-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";

/** memory_fact.embedding is NOT NULL VECTOR(1536); any unit vector will do. */
function unitVector(axis: number, dims = 1536): number[] {
  const v = new Array<number>(dims).fill(0);
  v[axis] = 1;
  return v;
}

/**
 * The M8.D promotion audit log. `bootstrap.ts` doesn't yet construct
 * this adapter, so nothing exercised it — but the port, the MemoryAgent
 * branch that writes through it and the `/promotions` read view all
 * exist, and finishing that wiring is easier with the SQL pinned.
 *
 * The interesting parts are the two COALESCE defaults on insert
 * (`source_session_ids`, `rejected`) and `listByOwner`, which reaches
 * the owner through a join on the origin agent rather than the fact.
 */
describe("PostgresMemoryPromotionEventRepository", () => {
  let pool: Pool;
  let promotions: PostgresMemoryPromotionEventRepository;
  let facts: PostgresMemoryFactRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;

  let owner: string;
  let agent: string;
  let fact: string;

  beforeAll(() => {
    pool = createTestPool();
    promotions = new PostgresMemoryPromotionEventRepository(pool);
    facts = new PostgresMemoryFactRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const person = await persons.create({ id: personId(), name: "Owner" });
    owner = person.id;
    const a = await agents.create({
      id: agentId(),
      name: "Origin",
      owner_id: owner,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    agent = a.id;
    const f = await facts.create({
      id: factId(),
      agent_id: agent,
      scope: "ic",
      fact_type: "pattern",
      content: "The deploy script needs a clean lockfile.",
      embedding: unitVector(0),
      source_chain_ids: [sessionId()],
      confidence: 1,
      valid_from: new Date("2026-01-01T00:00:00Z"),
      tags: [],
    });
    fact = f.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  function newEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: promotionEventId(),
      fact_id: fact,
      from_scope: "ic" as const,
      to_scope: "team" as const,
      origin_agent_id: agent,
      promoter_reason: "Two other agents hit the same lockfile problem.",
      source_session_ids: ["sess_aaaaaaaaaaaa"],
      rejected: false,
      ...overrides,
    };
  }

  it("create → findById roundtrips every column", async () => {
    const created = await promotions.create(newEvent());

    expect(created).toMatchObject({
      fact_id: fact,
      from_scope: "ic",
      to_scope: "team",
      origin_agent_id: agent,
      promoter_reason: "Two other agents hit the same lockfile problem.",
      source_session_ids: ["sess_aaaaaaaaaaaa"],
      rejected: false,
    });
    expect(created.created_at).toBeInstanceOf(Date);

    const found = await promotions.findById(created.id);
    expect(found).toEqual(created);
  });

  it("records a null from_scope for a fact that had no prior scope", async () => {
    const created = await promotions.create(newEvent({ from_scope: null }));

    expect(created.from_scope).toBeNull();
    expect((await promotions.findById(created.id))?.from_scope).toBeNull();
  });

  it("records a rejection as a first-class event", async () => {
    const created = await promotions.create(
      newEvent({ rejected: true, promoter_reason: "Too specific to one repo." }),
    );

    expect(created.rejected).toBe(true);
    expect(created.promoter_reason).toBe("Too specific to one repo.");
  });

  it("defaults source_session_ids to an empty array and rejected to false", async () => {
    const created = await promotions.create(
      newEvent({ source_session_ids: undefined, rejected: undefined }) as Parameters<
        typeof promotions.create
      >[0],
    );

    expect(created.source_session_ids).toEqual([]);
    expect(created.rejected).toBe(false);
  });

  it("findById returns undefined for an unknown id", async () => {
    expect(await promotions.findById("mpe_nosuchevent")).toBeUndefined();
  });

  describe("listByOwner", () => {
    it("returns the owner's events newest first, capped by limit", async () => {
      const first = await promotions.create(newEvent());
      const second = await promotions.create(newEvent());
      const third = await promotions.create(newEvent());
      // created_at defaults to now() at insert time, so insertion order
      // is chronological — but ties are possible within a millisecond.
      // Assert on set membership for the capped call and on the full
      // ordering only through the ids we know are distinct rows.
      const all = await promotions.listByOwner(owner, 10);

      expect(all).toHaveLength(3);
      expect(new Set(all.map((e) => e.id))).toEqual(
        new Set([first.id, second.id, third.id]),
      );
      expect(await promotions.listByOwner(owner, 2)).toHaveLength(2);
    });

    it("orders by created_at descending", async () => {
      const now = Date.now();
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const created = await promotions.create(newEvent());
        await pool.query(`UPDATE memory_promotion_event SET created_at = $1 WHERE id = $2`, [
          new Date(now - i * 60_000),
          created.id,
        ]);
        ids.push(created.id);
      }

      const listed = await promotions.listByOwner(owner, 10);

      expect(listed.map((e) => e.id)).toEqual(ids);
    });

    it("excludes events whose origin agent belongs to a different owner", async () => {
      const stranger = await persons.create({ id: personId(), name: "Stranger" });
      const strangerAgent = await agents.create({
        id: agentId(),
        name: "Stranger's agent",
        owner_id: stranger.id,
        hierarchy_level: "ic",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      });
      const mine = await promotions.create(newEvent());
      await promotions.create(newEvent({ origin_agent_id: strangerAgent.id }));

      const listed = await promotions.listByOwner(owner, 10);

      expect(listed.map((e) => e.id)).toEqual([mine.id]);
      expect(await promotions.listByOwner(stranger.id, 10)).toHaveLength(1);
    });

    it("returns an empty list for an owner with no promotions", async () => {
      expect(await promotions.listByOwner("person_nobody", 10)).toEqual([]);
    });
  });
});
