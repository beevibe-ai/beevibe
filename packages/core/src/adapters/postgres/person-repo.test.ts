import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { personId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresPersonRepository } from "./person-repo.js";

describe("PostgresPersonRepository", () => {
  let pool: Pool;
  let repo: PostgresPersonRepository;

  beforeAll(() => {
    pool = createTestPool();
    repo = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("create + findById round-trips", async () => {
    const id = personId();
    const created = await repo.create({ id, name: "Dan", email: "dan@example.com" });
    expect(created.id).toBe(id);
    expect(created.name).toBe("Dan");
    expect(created.email).toBe("dan@example.com");
    expect(created.created_at).toBeInstanceOf(Date);

    const found = await repo.findById(id);
    expect(found).toEqual(created);
  });

  it("create without email returns undefined for email (null→undefined at boundary)", async () => {
    const p = await repo.create({ id: personId(), name: "No Email" });
    expect(p.email).toBeUndefined();
  });

  it("findById returns undefined when missing", async () => {
    const found = await repo.findById("person_missing");
    expect(found).toBeUndefined();
  });

  it("findByEmail hits the unique constraint path", async () => {
    const p = await repo.create({ id: personId(), name: "Dan", email: "dan@x.com" });
    const found = await repo.findByEmail("dan@x.com");
    expect(found?.id).toBe(p.id);
  });

  it("findByEmail returns undefined when absent", async () => {
    expect(await repo.findByEmail("nobody@x.com")).toBeUndefined();
  });

  it("email UNIQUE constraint is enforced", async () => {
    await repo.create({ id: personId(), name: "A", email: "same@x.com" });
    await expect(
      repo.create({ id: personId(), name: "B", email: "same@x.com" }),
    ).rejects.toThrow();
  });

  it("findByApiKey round-trips an assigned key", async () => {
    const p = await repo.create({
      id: personId(),
      name: "Keyed",
      api_key: "bv_u_test_token",
    });
    const found = await repo.findByApiKey("bv_u_test_token");
    expect(found?.id).toBe(p.id);
    expect(found?.api_key).toBe("bv_u_test_token");
  });

  it("findByApiKey returns undefined when the key is not set", async () => {
    await repo.create({ id: personId(), name: "NoKey" });
    expect(await repo.findByApiKey("bv_u_missing")).toBeUndefined();
  });

  it("api_key UNIQUE constraint is enforced", async () => {
    await repo.create({ id: personId(), name: "A", api_key: "bv_u_dup" });
    await expect(
      repo.create({ id: personId(), name: "B", api_key: "bv_u_dup" }),
    ).rejects.toThrow();
  });

  it("update can set and rotate api_key", async () => {
    const p = await repo.create({ id: personId(), name: "Rotator" });
    expect(p.api_key).toBeUndefined();

    const withKey = await repo.update(p.id, { api_key: "bv_u_first" });
    expect(withKey.api_key).toBe("bv_u_first");

    const rotated = await repo.update(p.id, { api_key: "bv_u_second" });
    expect(rotated.api_key).toBe("bv_u_second");
    expect(await repo.findByApiKey("bv_u_first")).toBeUndefined();
    expect((await repo.findByApiKey("bv_u_second"))?.id).toBe(p.id);
  });

  it("findManyByIds returns rows for given IDs, empty array for empty input", async () => {
    const a = await repo.create({ id: personId(), name: "A" });
    const b = await repo.create({ id: personId(), name: "B" });
    const c = await repo.create({ id: personId(), name: "C" });

    const subset = await repo.findManyByIds([a.id, c.id]);
    expect(subset.map((p) => p.id).sort()).toEqual([a.id, c.id].sort());
    expect(subset.find((p) => p.id === b.id)).toBeUndefined();

    expect(await repo.findManyByIds([])).toEqual([]);
  });

  it("update patches name + email, sets updated_at forward", async () => {
    const p = await repo.create({ id: personId(), name: "Before", email: "before@x.com" });
    const beforeUpdate = p.updated_at.getTime();
    await new Promise((r) => setTimeout(r, 10));

    const updated = await repo.update(p.id, { name: "After", email: "after@x.com" });
    expect(updated.name).toBe("After");
    expect(updated.email).toBe("after@x.com");
    expect(updated.updated_at.getTime()).toBeGreaterThan(beforeUpdate);
  });

  it("update with empty patch returns existing row unchanged", async () => {
    const p = await repo.create({ id: personId(), name: "X" });
    const after = await repo.update(p.id, {});
    expect(after).toEqual(p);
  });

  it("update throws when id is missing", async () => {
    await expect(repo.update("person_missing", { name: "X" })).rejects.toThrow(/not found/);
  });

  it("delete removes the row", async () => {
    const p = await repo.create({ id: personId(), name: "Ephemeral" });
    await repo.delete(p.id);
    expect(await repo.findById(p.id)).toBeUndefined();
  });
});
