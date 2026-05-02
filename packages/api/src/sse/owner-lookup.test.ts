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
    const owners = await lookup.ownersOf({ event: "session.step", id: "sess_1" });
    expect([...owners]).toEqual(["person_c"]);
  });

  it("resolves mesh.activity to both initiator and counterparty owners", async () => {
    const { pool } = fakePool([{ initiator: "person_a", counterparty: "person_b" }]);
    const lookup = new OwnerLookup(pool);
    const owners = await lookup.ownersOf({ event: "mesh.activity", id: "neg_1" });
    expect([...owners].sort()).toEqual(["person_a", "person_b"]);
  });

  it("returns empty set for missing entity (fail-closed)", async () => {
    const { pool } = fakePool([]);
    const lookup = new OwnerLookup(pool);
    const owners = await lookup.ownersOf({ event: "task.updated", id: "task_x" });
    expect(owners.size).toBe(0);
  });

  it("returns empty set for unknown event type", async () => {
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
});
