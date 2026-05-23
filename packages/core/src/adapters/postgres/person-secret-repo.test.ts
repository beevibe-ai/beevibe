import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { personId, personSecretId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresPersonSecretRepository } from "./person-secret-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";

const SAMPLE_RECORD = (overrides: Partial<{
  id: string;
  person_id: string;
  name: string;
  description: string;
}> = {}) => ({
  id: overrides.id ?? personSecretId(),
  person_id: overrides.person_id!,
  name: overrides.name ?? "OPENAI_API_KEY",
  description: overrides.description,
  // Realistic-shape ciphertext stand-ins. We're testing the SQL layer
  // here, not the crypto layer — secrets.test.ts covers AES-GCM
  // correctness end-to-end.
  value_encrypted: "deadbeefcafef00d",
  value_iv: "000102030405060708090a0b",
  value_tag: "00112233445566778899aabbccddeeff",
});

describe("PostgresPersonSecretRepository", () => {
  let pool: Pool;
  let secrets: PostgresPersonSecretRepository;
  let persons: PostgresPersonRepository;
  let ownerId: string;
  let otherOwnerId: string;

  beforeAll(() => {
    pool = createTestPool();
    secrets = new PostgresPersonSecretRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    ownerId = (await persons.create({ id: personId(), name: "Owner" })).id;
    otherOwnerId = (await persons.create({ id: personId(), name: "Other" })).id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("upsert inserts a new row + listByPerson returns metadata only (no ciphertext)", async () => {
    const sample = SAMPLE_RECORD({ person_id: ownerId, description: "for ADR" });
    await secrets.upsert(sample);
    const listed = await secrets.listByPerson(ownerId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe("OPENAI_API_KEY");
    expect(listed[0]!.description).toBe("for ADR");
    // PersonSecret intentionally lacks the ciphertext fields — TypeScript
    // hides them at compile-time, this guards against any future widening.
    expect((listed[0] as Record<string, unknown>).value_encrypted).toBeUndefined();
  });

  it("upsert overwrites ciphertext + updates updated_at when re-adding the same name", async () => {
    const first = SAMPLE_RECORD({ person_id: ownerId });
    await secrets.upsert(first);
    const before = await secrets.findRecord(ownerId, "OPENAI_API_KEY");
    expect(before).toBeDefined();
    expect(before!.value_encrypted).toBe("deadbeefcafef00d");
    expect(before!.value_iv).toBe("000102030405060708090a0b");

    // Wait a tick so the updated_at delta is observable.
    await new Promise((r) => setTimeout(r, 25));

    const rotated = {
      ...first,
      value_encrypted: "1111111111111111",
      value_iv: "111213141516171819202122",
      value_tag: "33445566778899aabbccddeeff001122",
    };
    await secrets.upsert(rotated);
    const after = await secrets.findRecord(ownerId, "OPENAI_API_KEY");
    expect(after!.value_encrypted).toBe("1111111111111111");
    expect(after!.value_iv).toBe("111213141516171819202122");
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());

    // Still only one row — the unique constraint kept it merged.
    const listed = await secrets.listByPerson(ownerId);
    expect(listed).toHaveLength(1);
  });

  it("findRecord returns undefined when the secret belongs to a different person", async () => {
    await secrets.upsert(SAMPLE_RECORD({ person_id: ownerId }));
    const found = await secrets.findRecordsByNames(otherOwnerId, ["OPENAI_API_KEY"]);
    expect(found.size).toBe(0);
  });

  it("findRecordsByNames batches and returns only matching names", async () => {
    await secrets.upsert(SAMPLE_RECORD({ person_id: ownerId, name: "OPENAI_API_KEY" }));
    await secrets.upsert(SAMPLE_RECORD({ person_id: ownerId, name: "TAVILY_API_KEY" }));
    const found = await secrets.findRecordsByNames(ownerId, [
      "OPENAI_API_KEY",
      "TAVILY_API_KEY",
      "BRAVE_SEARCH_API_KEY",
    ]);
    expect(found.size).toBe(2);
    expect(found.get("OPENAI_API_KEY")).toBeDefined();
    expect(found.get("TAVILY_API_KEY")).toBeDefined();
    expect(found.get("BRAVE_SEARCH_API_KEY")).toBeUndefined();
  });

  it("delete is owner-scoped and returns false on cross-tenant attempts", async () => {
    const secret = SAMPLE_RECORD({ person_id: ownerId });
    await secrets.upsert(secret);

    const crossTenant = await secrets.delete(secret.id, otherOwnerId);
    expect(crossTenant).toBe(false);
    expect(await secrets.listByPerson(ownerId)).toHaveLength(1);

    const own = await secrets.delete(secret.id, ownerId);
    expect(own).toBe(true);
    expect(await secrets.listByPerson(ownerId)).toHaveLength(0);
  });
});
