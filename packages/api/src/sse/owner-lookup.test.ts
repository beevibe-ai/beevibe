import { describe, it, expect, vi } from "vitest";
import { OwnerLookup } from "./owner-lookup.js";
import type { Pool } from "@beevibe/core/adapters/postgres";

function fakePool(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async () => ({ rows }));
  return { pool: { query } as unknown as Pool, query };
}

describe("OwnerLookup", () => {
  it("resolves task events via assignee.owner_id", async () => {
    const { pool, query } = fakePool([{ owner: "person_a" }]);
    const lookup = new OwnerLookup(pool);
    const owners = await lookup.ownersOf({ event: "task.updated", id: "task_1" });
    expect([...owners]).toEqual(["person_a"]);
    expect(query).toHaveBeenCalledOnce();
  });

  it("resolves agent events via agent.owner_id", async () => {
    const { pool } = fakePool([{ owner: "person_b" }]);
    const lookup = new OwnerLookup(pool);
    const owners = await lookup.ownersOf({ event: "agent.updated", id: "agent_1" });
    expect([...owners]).toEqual(["person_b"]);
  });

  it("resolves session events via agent.owner_id", async () => {
    const { pool } = fakePool([{ owner: "person_c" }]);
    const lookup = new OwnerLookup(pool);
    const owners = await lookup.ownersOf({ event: "session.event", id: "sess_1" });
    expect([...owners]).toEqual(["person_c"]);
  });

  it("resolves mesh.activity to both initiator and counterparty owners", async () => {
    const { pool } = fakePool([{ initiator: "person_a", counterparty: "person_b" }]);
    const lookup = new OwnerLookup(pool);
    const owners = await lookup.ownersOf({ event: "mesh.activity", id: "neg_1" });
    expect([...owners].sort()).toEqual(["person_a", "person_b"]);
  });

  it("resolves runtime.updated via daemon.owner_person_id", async () => {
    const { pool } = fakePool([{ owner: "person_d" }]);
    const lookup = new OwnerLookup(pool);
    const owners = await lookup.ownersOf({ event: "runtime.updated", id: "rt_1" });
    expect([...owners]).toEqual(["person_d"]);
  });

  it("returns empty set for missing entity (fail-closed)", async () => {
    const { pool } = fakePool([]);
    const lookup = new OwnerLookup(pool);
    const owners = await lookup.ownersOf({ event: "task.updated", id: "task_x" });
    expect(owners.size).toBe(0);
  });

  it("returns empty set for unknown event type without querying the DB", async () => {
    const { pool, query } = fakePool();
    const lookup = new OwnerLookup(pool);
    const owners = await lookup.ownersOf({ event: "unrelated.event", id: "x" });
    expect(owners.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("caches successive lookups for the same event id", async () => {
    const { pool, query } = fakePool([{ owner: "person_a" }]);
    const lookup = new OwnerLookup(pool);
    await lookup.ownersOf({ event: "task.updated", id: "task_1" });
    await lookup.ownersOf({ event: "task.updated", id: "task_1" });
    expect(query).toHaveBeenCalledOnce();
  });

  it("respects the configured cache cap via FIFO eviction", async () => {
    const { pool } = fakePool([{ owner: "person_a" }]);
    const lookup = new OwnerLookup(pool, { cacheMaxEntries: 2 });

    await lookup.ownersOf({ event: "task.updated", id: "task_1" });
    await lookup.ownersOf({ event: "task.updated", id: "task_2" });
    await lookup.ownersOf({ event: "task.updated", id: "task_3" });

    // Cache should hold at most 2 entries; FIFO drops task_1 first.
    // Verify by re-querying task_1 and asserting another DB hit.
    const before = (pool as unknown as { query: { mock: { calls: unknown[] } } }).query.mock.calls.length;
    await lookup.ownersOf({ event: "task.updated", id: "task_1" });
    const after = (pool as unknown as { query: { mock: { calls: unknown[] } } }).query.mock.calls.length;
    expect(after).toBe(before + 1);
  });

  it("dedupes concurrent lookups for the same key (no N+1)", async () => {
    let resolveQuery: (value: { rows: Array<{ owner: string }> }) => void = () => {};
    const query = vi.fn(
      () =>
        new Promise<{ rows: Array<{ owner: string }> }>((resolve) => {
          resolveQuery = resolve;
        }),
    );
    const pool = { query } as unknown as Pool;
    const lookup = new OwnerLookup(pool);

    // Fire two lookups for the same key BEFORE the first promise resolves.
    const first = lookup.ownersOf({ event: "task.updated", id: "task_1" });
    const second = lookup.ownersOf({ event: "task.updated", id: "task_1" });
    expect(query).toHaveBeenCalledOnce();

    resolveQuery({ rows: [{ owner: "person_a" }] });
    const [a, b] = await Promise.all([first, second]);
    expect([...a]).toEqual(["person_a"]);
    expect([...b]).toEqual(["person_a"]);
    expect(query).toHaveBeenCalledOnce();
  });

  it("returns empty set when the DB query throws (drops the event)", async () => {
    const query = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const pool = { query } as unknown as Pool;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const lookup = new OwnerLookup(pool);
    const owners = await lookup.ownersOf({ event: "task.updated", id: "task_1" });

    expect(owners.size).toBe(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("treats owner_id as immutable for the cache window — staleness is documented", async () => {
    // If a future feature reassigns owner_id (not currently possible), the
    // cached result is masked for cacheTtlMs. This test pins that
    // assumption: changing the underlying row doesn't affect cached
    // results until TTL elapses or clearCache() is called.
    const owners1 = [{ owner: "person_a" }];
    const owners2 = [{ owner: "person_b" }];
    let returnFirst = true;
    const query = vi.fn(async () => ({ rows: returnFirst ? owners1 : owners2 }));
    const pool = { query } as unknown as Pool;

    const lookup = new OwnerLookup(pool, { cacheTtlMs: 10_000 });
    const a = await lookup.ownersOf({ event: "agent.updated", id: "agent_1" });
    expect([...a]).toEqual(["person_a"]);

    returnFirst = false;
    const b = await lookup.ownersOf({ event: "agent.updated", id: "agent_1" });
    expect([...b]).toEqual(["person_a"]); // still cached

    lookup.clearCache();
    const c = await lookup.ownersOf({ event: "agent.updated", id: "agent_1" });
    expect([...c]).toEqual(["person_b"]); // post-eviction
  });
});
