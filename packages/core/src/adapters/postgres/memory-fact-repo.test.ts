import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import { agentId, factId, personId, sessionId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresMemoryFactRepository } from "./memory-fact-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";

/** Build a deterministic 1536-dim unit vector aligned to the given axis. */
function unitVector(axis: number, dims = 1536): number[] {
  const v = new Array<number>(dims).fill(0);
  v[axis] = 1;
  return v;
}

/** Build a 1536-dim vector that points mostly toward axis A but leans toward B. */
function leaningVector(a: number, b: number, weight = 0.8, dims = 1536): number[] {
  const v = new Array<number>(dims).fill(0);
  v[a] = weight;
  v[b] = Math.sqrt(1 - weight * weight); // keep unit length
  return v;
}

describe("PostgresMemoryFactRepository", () => {
  let pool: Pool;
  let facts: PostgresMemoryFactRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let aid: string;

  beforeAll(() => {
    pool = createTestPool();
    facts = new PostgresMemoryFactRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Owner" });
    const a = await agents.create({
      id: agentId(),
      name: "A",
      owner_id: owner.id,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    aid = a.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("create → findById roundtrip preserves all fields including 1536-dim vector", async () => {
    const sid = sessionId();
    const created = await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "preference",
      content: "Prefers pnpm over npm",
      embedding: unitVector(5),
      source_session_ids: [sid],
    });
    expect(created.embedding).toHaveLength(1536);
    expect(created.embedding[5]).toBeCloseTo(1.0, 5);
    expect(created.source_session_ids).toEqual([sid]);

    const fetched = await facts.findById(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.content).toBe("Prefers pnpm over npm");
    expect(fetched!.embedding).toHaveLength(1536);
    expect(fetched!.embedding[5]).toBeCloseTo(1.0, 5);
  });

  it("findByIds returns facts in any order for a given id set (empty input → empty result)", async () => {
    const a = await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "x",
      embedding: unitVector(0),
      source_session_ids: [],
    });
    const b = await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "y",
      embedding: unitVector(1),
      source_session_ids: [],
    });
    const list = await facts.findByIds([a.id, b.id]);
    expect(list).toHaveLength(2);
    expect(new Set(list.map((f) => f.id))).toEqual(new Set([a.id, b.id]));

    expect(await facts.findByIds([])).toEqual([]);
  });

  it("searchByVector orders by cosine similarity (nearest first)", async () => {
    // Three facts along different axes.
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "axis 0",
      embedding: unitVector(0),
      source_session_ids: [],
    });
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "leans 0→1",
      embedding: leaningVector(0, 1, 0.9),
      source_session_ids: [],
    });
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "axis 1",
      embedding: unitVector(1),
      source_session_ids: [],
    });

    // Query on axis 0: axis-0 fact is nearest, leaning next, axis-1 farthest.
    const ranked = await facts.searchByVector({
      agent_id: aid,
      scope: "ic",
      embedding: unitVector(0),
      limit: 3,
    });
    expect(ranked.map((f) => f.content)).toEqual(["axis 0", "leans 0→1", "axis 1"]);
  });

  it("searchByVector respects min_similarity floor", async () => {
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "axis 0",
      embedding: unitVector(0),
      source_session_ids: [],
    });
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "axis 1 (orthogonal)",
      embedding: unitVector(1),
      source_session_ids: [],
    });
    // Query on axis 0 with min_similarity > 0.5: orthogonal axis-1 (sim ≈ 0) gets dropped.
    const ranked = await facts.searchByVector({
      agent_id: aid,
      scope: "ic",
      embedding: unitVector(0),
      limit: 10,
      min_similarity: 0.5,
    });
    expect(ranked.map((f) => f.content)).toEqual(["axis 0"]);
  });

  it("searchByVector respects fact_types filter", async () => {
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "preference",
      content: "pref",
      embedding: unitVector(0),
      source_session_ids: [],
    });
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "gotcha",
      content: "gotcha",
      embedding: unitVector(0),
      source_session_ids: [],
    });
    const onlyPref = await facts.searchByVector({
      agent_id: aid,
      scope: "ic",
      embedding: unitVector(0),
      limit: 10,
      fact_types: ["preference"],
    });
    expect(onlyPref.map((f) => f.content)).toEqual(["pref"]);
  });

  it("searchByVector respects scope union", async () => {
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "ic-fact",
      embedding: unitVector(0),
      source_session_ids: [],
    });
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "team",
      fact_type: "belief",
      content: "team-fact",
      embedding: unitVector(0),
      source_session_ids: [],
    });

    const icOnly = await facts.searchByVector({
      agent_id: aid,
      scope: "ic",
      embedding: unitVector(0),
      limit: 10,
    });
    expect(icOnly.map((f) => f.content).sort()).toEqual(["ic-fact"]);

    const bothScopes = await facts.searchByVector({
      agent_id: aid,
      scope: ["ic", "team"],
      embedding: unitVector(0),
      limit: 10,
    });
    expect(bothScopes.map((f) => f.content).sort()).toEqual(["ic-fact", "team-fact"]);
  });

  it("listBySessionId returns every fact whose source_session_ids contains the id", async () => {
    const sA = sessionId();
    const sB = sessionId();
    const f1 = await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "A-only",
      embedding: unitVector(0),
      source_session_ids: [sA],
    });
    const f2 = await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "A+B",
      embedding: unitVector(1),
      source_session_ids: [sA, sB],
    });
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "B-only",
      embedding: unitVector(2),
      source_session_ids: [sB],
    });

    const fromA = await facts.listBySessionId(sA);
    expect(new Set(fromA.map((f) => f.id))).toEqual(new Set([f1.id, f2.id]));
  });

  it("update content + embedding + source_session_ids works (merge path)", async () => {
    const sA = sessionId();
    const sB = sessionId();
    const f = await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "old",
      embedding: unitVector(0),
      source_session_ids: [sA],
    });
    const updated = await facts.update(f.id, {
      content: "merged",
      embedding: unitVector(7),
      source_session_ids: [sB],
    });
    expect(updated.content).toBe("merged");
    expect(updated.embedding[7]).toBeCloseTo(1.0, 5);
    // Union semantics: old [sA] merged with new [sB] → {sA, sB} (order undefined).
    expect(new Set(updated.source_session_ids)).toEqual(new Set([sA, sB]));
  });

  it("source_session_ids update is atomic union under concurrent writes", async () => {
    const sA = sessionId();
    const sB = sessionId();
    const sC = sessionId();
    const f = await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "shared fact",
      embedding: unitVector(0),
      source_session_ids: [sA],
    });

    // Two parallel updates, each adding a different session id. With a naive
    // patch-overwrite implementation, one would clobber the other. With
    // atomic SQL union, every id must land.
    await Promise.all([
      facts.update(f.id, { source_session_ids: [sB] }),
      facts.update(f.id, { source_session_ids: [sC] }),
    ]);

    const final = await facts.findById(f.id);
    expect(final).toBeDefined();
    expect(new Set(final!.source_session_ids)).toEqual(new Set([sA, sB, sC]));
  });

  it("source_session_ids update dedupes: passing an id that already exists is a no-op on that id", async () => {
    const sA = sessionId();
    const f = await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "x",
      embedding: unitVector(0),
      source_session_ids: [sA],
    });
    const updated = await facts.update(f.id, { source_session_ids: [sA] });
    expect(updated.source_session_ids).toEqual([sA]);
  });

  it("heavy concurrency: 10 parallel updates each adding its own session id land every id", async () => {
    const sA = sessionId();
    const f = await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "hotly contested fact",
      embedding: unitVector(0),
      source_session_ids: [sA],
    });

    const newIds = Array.from({ length: 10 }, () => sessionId());
    await Promise.all(
      newIds.map((sid) => facts.update(f.id, { source_session_ids: [sid] })),
    );

    const final = await facts.findById(f.id);
    expect(final).toBeDefined();
    expect(new Set(final!.source_session_ids)).toEqual(new Set([sA, ...newIds]));
    // Exactly 11 entries — no duplicates, no drops.
    expect(final!.source_session_ids).toHaveLength(11);
  });

  it("update with only scope promotes a fact (IC → team)", async () => {
    const f = await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "bubble me up",
      embedding: unitVector(0),
      source_session_ids: [],
    });
    const promoted = await facts.update(f.id, { scope: "team" });
    expect(promoted.scope).toBe("team");
  });

  it("update throws for a non-existent id", async () => {
    await expect(facts.update("fact_nope", { content: "x" })).rejects.toThrow(/not found/);
  });

  it("delete removes the fact", async () => {
    const f = await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "ephemeral",
      embedding: unitVector(0),
      source_session_ids: [],
    });
    await facts.delete(f.id);
    expect(await facts.findById(f.id)).toBeUndefined();
  });

  it("listByAgentScope orders by created_at DESC and respects limit", async () => {
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "first",
      embedding: unitVector(0),
      source_session_ids: [],
    });
    await new Promise((r) => setTimeout(r, 10));
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "second",
      embedding: unitVector(1),
      source_session_ids: [],
    });
    const ordered = await facts.listByAgentScope(aid, "ic");
    expect(ordered.map((f) => f.content)).toEqual(["second", "first"]);

    const capped = await facts.listByAgentScope(aid, "ic", 1);
    expect(capped.map((f) => f.content)).toEqual(["second"]);
  });

  it("deleting agent cascades to facts (FK ON DELETE CASCADE)", async () => {
    await facts.create({
      id: factId(),
      agent_id: aid,
      scope: "ic",
      fact_type: "belief",
      content: "x",
      embedding: unitVector(0),
      source_session_ids: [],
    });
    await agents.delete(aid);
    expect(await facts.listByAgentScope(aid, "ic")).toEqual([]);
  });
});
