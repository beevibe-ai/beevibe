import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { daemonId, personId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresDaemonRepository } from "./daemon-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";

describe("PostgresDaemonRepository", () => {
  let pool: Pool;
  let daemons: PostgresDaemonRepository;
  let persons: PostgresPersonRepository;
  let ownerId: string;

  beforeAll(() => {
    pool = createTestPool();
    daemons = new PostgresDaemonRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Owner" });
    ownerId = owner.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a daemon row and round-trips it via findById", async () => {
    const id = daemonId();
    const created = await daemons.create({
      id,
      owner_person_id: ownerId,
      external_id: "macbook-pro-abc",
      device_name: "MacBook Pro",
      token_hash: "argon2$abc",
    });
    expect(created.id).toBe(id);
    expect(created.revoked_at).toBeUndefined();

    const found = await daemons.findById(id);
    expect(found?.device_name).toBe("MacBook Pro");
    expect(found?.token_hash).toBe("argon2$abc");
  });

  it("findByOwnerAndExternalId returns the matching active daemon", async () => {
    const id = daemonId();
    await daemons.create({
      id,
      owner_person_id: ownerId,
      external_id: "host-a",
      device_name: "Host A",
      token_hash: "h1",
    });
    const found = await daemons.findByOwnerAndExternalId(ownerId, "host-a");
    expect(found?.id).toBe(id);
    const miss = await daemons.findByOwnerAndExternalId(ownerId, "other");
    expect(miss).toBeUndefined();
  });

  it("findByTokenHash skips revoked daemons", async () => {
    const id = daemonId();
    await daemons.create({
      id,
      owner_person_id: ownerId,
      external_id: "h",
      device_name: "H",
      token_hash: "shared-token",
    });
    expect((await daemons.findByTokenHash("shared-token"))?.id).toBe(id);
    await daemons.revoke(id);
    expect(await daemons.findByTokenHash("shared-token")).toBeUndefined();
  });

  it("listActiveByOwner excludes revoked rows", async () => {
    const a = daemonId();
    const b = daemonId();
    await daemons.create({
      id: a,
      owner_person_id: ownerId,
      external_id: "ha",
      device_name: "A",
      token_hash: "ta",
    });
    await daemons.create({
      id: b,
      owner_person_id: ownerId,
      external_id: "hb",
      device_name: "B",
      token_hash: "tb",
    });
    await daemons.revoke(b);
    const active = await daemons.listActiveByOwner(ownerId);
    expect(active.map((d) => d.id)).toEqual([a]);
  });

  it("touchLastSeen advances last_seen_at", async () => {
    const id = daemonId();
    await daemons.create({
      id,
      owner_person_id: ownerId,
      external_id: "h",
      device_name: "H",
      token_hash: "t",
    });
    const before = await daemons.findById(id);
    expect(before?.last_seen_at).toBeUndefined();
    await daemons.touchLastSeen(id);
    const after = await daemons.findById(id);
    expect(after?.last_seen_at).toBeInstanceOf(Date);
  });

  it("update applies partial patches", async () => {
    const id = daemonId();
    await daemons.create({
      id,
      owner_person_id: ownerId,
      external_id: "h",
      device_name: "Original",
      token_hash: "t1",
    });
    const updated = await daemons.update(id, { device_name: "Renamed" });
    expect(updated.device_name).toBe("Renamed");
    expect(updated.token_hash).toBe("t1");
  });
});
