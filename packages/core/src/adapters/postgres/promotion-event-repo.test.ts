/**
 * `memory_promotion_event` adapter — integration tests against Postgres.
 *
 * The M8.D promotion audit log is written by MemoryAgent and read by
 * `views/promotions.ts`; the adapter itself was never covered because
 * `bootstrap.ts` doesn't construct it yet (CLAUDE.md records this as
 * unfinished wiring, not dead code). Testing it now means the read side
 * is known-good when the wiring lands, and pins the two things a caller
 * can't see from the port: the COALESCE defaults on `source_session_ids`
 * / `rejected`, and that `listByOwner` joins through `agent.owner_id`
 * rather than through the fact — so an event only reaches the owner of
 * the *origin agent*.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import { agentId, factId, personId, promotionEventId, sessionId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresMemoryFactRepository } from "./memory-fact-repo.js";
import { PostgresMemoryPromotionEventRepository } from "./promotion-event-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";

/** A deterministic 1536-dim unit vector; content doesn't matter here. */
function unitVector(axis = 0, dims = 1536): number[] {
  const v = new Array<number>(dims).fill(0);
  v[axis] = 1;
  return v;
}

describe("PostgresMemoryPromotionEventRepository", () => {
  let pool: Pool;
  let promotions: PostgresMemoryPromotionEventRepository;
  let facts: PostgresMemoryFactRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let ownerId: string;
  let originAgentId: string;
  let factRowId: string;

  beforeAll(() => {
    pool = createTestPool();
    promotions = new PostgresMemoryPromotionEventRepository(pool);
    facts = new PostgresMemoryFactRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Owner" });
    ownerId = owner.id;
    originAgentId = await makeAgent(ownerId, "Origin");
    factRowId = await makeFact(originAgentId);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function makeAgent(owner: string, name: string): Promise<string> {
    const a = await agents.create({
      id: agentId(),
      name,
      owner_id: owner,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    return a.id;
  }

  async function makeFact(agent: string): Promise<string> {
    const f = await facts.create({
      id: factId(),
      agent_id: agent,
      scope: "ic",
      fact_type: "belief",
      content: "pnpm is the package manager here",
      embedding: unitVector(),
      source_session_ids: [],
    });
    return f.id;
  }

  function newEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: promotionEventId(),
      fact_id: factRowId,
      from_scope: "ic" as const,
      to_scope: "team" as const,
      origin_agent_id: originAgentId,
      promoter_reason: "seen in three sessions",
      source_session_ids: [] as string[],
      rejected: false,
      ...overrides,
    };
  }

  it("round-trips every column on create", async () => {
    const sid = sessionId();
    const created = await promotions.create(
      newEvent({ source_session_ids: [sid], promoter_reason: "corroborated twice" }),
    );

    expect(created).toMatchObject({
      fact_id: factRowId,
      from_scope: "ic",
      to_scope: "team",
      origin_agent_id: originAgentId,
      promoter_reason: "corroborated twice",
      source_session_ids: [sid],
      rejected: false,
    });
    expect(created.created_at).toBeInstanceOf(Date);
  });

  it("records a null from_scope for a first-time promotion", async () => {
    const created = await promotions.create(newEvent({ from_scope: null }));
    expect(created.from_scope).toBeNull();

    const fetched = await promotions.findById(created.id);
    expect(fetched?.from_scope).toBeNull();
  });

  it("records a rejected decision — the audit log keeps both outcomes", async () => {
    const created = await promotions.create(
      newEvent({ rejected: true, promoter_reason: "single anecdote, not a pattern" }),
    );
    expect(created.rejected).toBe(true);
    expect((await promotions.findById(created.id))?.rejected).toBe(true);
  });

  it.each([
    ["undefined source_session_ids", { source_session_ids: undefined }],
    ["null source_session_ids", { source_session_ids: null }],
  ])("COALESCEs %s to an empty array", async (_label, patch) => {
    const created = await promotions.create(
      newEvent(patch) as unknown as Parameters<typeof promotions.create>[0],
    );
    expect(created.source_session_ids).toEqual([]);
  });

  it("COALESCEs an omitted `rejected` to false", async () => {
    const created = await promotions.create(
      newEvent({ rejected: undefined }) as unknown as Parameters<
        typeof promotions.create
      >[0],
    );
    expect(created.rejected).toBe(false);
  });

  describe("findById", () => {
    it("returns undefined for an unknown id", async () => {
      expect(await promotions.findById("mpe_nonexistent")).toBeUndefined();
    });
  });

  describe("listByOwner", () => {
    it("returns the owner's events newest first", async () => {
      const first = await promotions.create(newEvent({ promoter_reason: "first" }));
      const second = await promotions.create(newEvent({ promoter_reason: "second" }));
      const third = await promotions.create(newEvent({ promoter_reason: "third" }));
      // created_at defaults to now() at insert time; nudge them apart so
      // the DESC ordering is unambiguous rather than tie-broken. `first`
      // is stamped most recent, so it should come back at the head.
      await spread(pool, [first.id, second.id, third.id]);

      const rows = await promotions.listByOwner(ownerId, 10);
      expect(rows.map((r) => r.promoter_reason)).toEqual(["first", "second", "third"]);
    });

    it("caps at the given limit", async () => {
      await promotions.create(newEvent());
      await promotions.create(newEvent());
      await promotions.create(newEvent());
      expect(await promotions.listByOwner(ownerId, 2)).toHaveLength(2);
    });

    it("excludes events whose origin agent belongs to another owner", async () => {
      const other = await persons.create({ id: personId(), name: "Other" });
      const otherAgent = await makeAgent(other.id, "Theirs");
      const otherFact = await makeFact(otherAgent);

      const mine = await promotions.create(newEvent());
      await promotions.create(
        newEvent({ origin_agent_id: otherAgent, fact_id: otherFact }),
      );

      const rows = await promotions.listByOwner(ownerId, 10);
      expect(rows.map((r) => r.id)).toEqual([mine.id]);
      expect(await promotions.listByOwner(other.id, 10)).toHaveLength(1);
    });

    it("returns an empty array for an owner with no events", async () => {
      expect(await promotions.listByOwner("person_nonexistent", 10)).toEqual([]);
    });
  });

  it("cascades away when the underlying fact is deleted", async () => {
    const created = await promotions.create(newEvent());
    await facts.delete(factRowId);
    expect(await promotions.findById(created.id)).toBeUndefined();
  });
});

/**
 * Push the listed events one second apart, oldest-first in array order,
 * so `ORDER BY created_at DESC` has a deterministic answer. Same-
 * transaction inserts can otherwise share a now() timestamp.
 */
async function spread(pool: Pool, idsNewestFirst: string[]): Promise<void> {
  for (const [i, id] of idsNewestFirst.entries()) {
    await pool.query(
      `UPDATE memory_promotion_event SET created_at = NOW() - ($2 * INTERVAL '1 second') WHERE id = $1`,
      [id, i],
    );
  }
}
