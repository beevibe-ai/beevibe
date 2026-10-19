import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import {
  agentId,
  factId,
  personId,
  promotionEventId,
  sessionId,
} from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresMemoryFactRepository } from "./memory-fact-repo.js";
import { PostgresMemoryPromotionEventRepository } from "./promotion-event-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";

/** 1536-dim unit vector — memory_fact.embedding is a fixed-width vector. */
function unitVector(axis: number, dims = 1536): number[] {
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
    const owner = await persons.create({ id: personId(), name: "Owner" });
    ownerId = owner.id;
    const agent = await agents.create({
      id: agentId(),
      name: "A",
      owner_id: ownerId,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    originAgentId = agent.id;
    fact = (await newFact(originAgentId)).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  const newFact = (agent: string, axis = 0) =>
    facts.create({
      id: factId(),
      agent_id: agent,
      scope: "ic",
      fact_type: "preference",
      content: "Prefers pnpm",
      embedding: unitVector(axis),
      source_session_ids: [],
    });

  it("create round-trips every column", async () => {
    const sid = sessionId();
    const created = await promotions.create({
      id: promotionEventId(),
      fact_id: fact,
      from_scope: "ic",
      to_scope: "team",
      origin_agent_id: originAgentId,
      promoter_reason: "Useful to the whole team",
      source_session_ids: [sid],
      rejected: false,
    });

    expect(created.fact_id).toBe(fact);
    expect(created.from_scope).toBe("ic");
    expect(created.to_scope).toBe("team");
    expect(created.origin_agent_id).toBe(originAgentId);
    expect(created.promoter_reason).toBe("Useful to the whole team");
    expect(created.source_session_ids).toEqual([sid]);
    expect(created.rejected).toBe(false);
    expect(created.created_at).toBeInstanceOf(Date);
  });

  it("create accepts a null from_scope and preserves it", async () => {
    const created = await promotions.create({
      id: promotionEventId(),
      fact_id: fact,
      from_scope: null,
      to_scope: "ic",
      origin_agent_id: originAgentId,
      promoter_reason: "fact creation",
      source_session_ids: [],
      rejected: false,
    });
    expect(created.from_scope).toBeNull();
  });

  it("create records a rejected decision — the audit log keeps both outcomes", async () => {
    const created = await promotions.create({
      id: promotionEventId(),
      fact_id: fact,
      from_scope: "ic",
      to_scope: "org",
      origin_agent_id: originAgentId,
      promoter_reason: "Too narrow to be org-wide",
      source_session_ids: [],
      rejected: true,
    });
    expect(created.rejected).toBe(true);
  });

  it("findById returns the stored row, undefined for an unknown id", async () => {
    const created = await promotions.create({
      id: promotionEventId(),
      fact_id: fact,
      from_scope: "ic",
      to_scope: "team",
      origin_agent_id: originAgentId,
      promoter_reason: "r",
      source_session_ids: [],
      rejected: false,
    });

    const found = await promotions.findById(created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.promoter_reason).toBe("r");
    expect(await promotions.findById("mpe_missing")).toBeUndefined();
  });

  it("listByOwner joins through origin_agent_id → agent.owner_id, newest first", async () => {
    const mk = (reason: string) =>
      promotions.create({
        id: promotionEventId(),
        fact_id: fact,
        from_scope: "ic",
        to_scope: "team",
        origin_agent_id: originAgentId,
        promoter_reason: reason,
        source_session_ids: [],
        rejected: false,
      });

    const first = await mk("first");
    // created_at defaults to now(); separate the two so DESC is stable.
    await new Promise((r) => setTimeout(r, 10));
    const second = await mk("second");

    const list = await promotions.listByOwner(ownerId, 10);
    expect(list.map((e) => e.id)).toEqual([second.id, first.id]);
  });

  it("listByOwner excludes another owner's events and honors the limit", async () => {
    const stranger = await persons.create({ id: personId(), name: "Stranger" });
    const strangerAgent = await agents.create({
      id: agentId(),
      name: "S",
      owner_id: stranger.id,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    const strangerFact = await newFact(strangerAgent.id, 1);

    await promotions.create({
      id: promotionEventId(),
      fact_id: fact,
      from_scope: "ic",
      to_scope: "team",
      origin_agent_id: originAgentId,
      promoter_reason: "mine",
      source_session_ids: [],
      rejected: false,
    });
    await promotions.create({
      id: promotionEventId(),
      fact_id: strangerFact.id,
      from_scope: "ic",
      to_scope: "team",
      origin_agent_id: strangerAgent.id,
      promoter_reason: "theirs",
      source_session_ids: [],
      rejected: false,
    });

    const mine = await promotions.listByOwner(ownerId, 10);
    expect(mine.map((e) => e.promoter_reason)).toEqual(["mine"]);
    expect(await promotions.listByOwner(ownerId, 0)).toEqual([]);
    expect(await promotions.listByOwner("person_nobody", 10)).toEqual([]);
  });
});
