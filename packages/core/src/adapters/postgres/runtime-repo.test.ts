import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { daemonId, personId, runtimeId } from "../../domain/ids.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresDaemonRepository } from "./daemon-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresRuntimeRepository } from "./runtime-repo.js";

describe("PostgresRuntimeRepository", () => {
  let pool: Pool;
  let runtimes: PostgresRuntimeRepository;
  let daemons: PostgresDaemonRepository;
  let persons: PostgresPersonRepository;
  let ownerId: string;
  let dId: string;

  beforeAll(() => {
    pool = createTestPool();
    runtimes = new PostgresRuntimeRepository(pool);
    daemons = new PostgresDaemonRepository(pool);
    persons = new PostgresPersonRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Owner" });
    ownerId = owner.id;
    dId = daemonId();
    await daemons.create({
      id: dId,
      owner_person_id: ownerId,
      external_id: "host",
      device_name: "Host",
      token_hash: "t",
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a runtime, defaults capabilities to {}, round-trips", async () => {
    const id = runtimeId();
    const created = await runtimes.create({
      id,
      daemon_id: dId,
      cli: "claude",
      cli_version: "1.0.0",
    });
    expect(created.id).toBe(id);
    expect(created.cli).toBe("claude");
    expect(created.capabilities).toEqual({});

    const found = await runtimes.findById(id);
    expect(found?.cli_version).toBe("1.0.0");
  });

  it("findByDaemonAndCli enforces (daemon_id, cli) uniqueness", async () => {
    await runtimes.create({ id: runtimeId(), daemon_id: dId, cli: "claude" });
    const found = await runtimes.findByDaemonAndCli(dId, "claude");
    expect(found?.cli).toBe("claude");
    await expect(
      runtimes.create({ id: runtimeId(), daemon_id: dId, cli: "claude" }),
    ).rejects.toThrow();
  });

  it("listByOwnerAndCli orders by last_heartbeat DESC NULLS LAST and excludes revoked daemons", async () => {
    const r1 = runtimeId();
    const r2 = runtimeId();
    await runtimes.create({ id: r1, daemon_id: dId, cli: "claude" });
    await runtimes.create({ id: r2, daemon_id: dId, cli: "codex" });
    // Heartbeat r2's codex (different cli) — shouldn't appear in claude list
    await runtimes.heartbeat(r2);

    const claudeRuntimes = await runtimes.listByOwnerAndCli(ownerId, "claude");
    expect(claudeRuntimes.map((r) => r.id)).toEqual([r1]);

    // Revoke daemon → both runtimes excluded.
    await daemons.revoke(dId);
    const post = await runtimes.listByOwnerAndCli(ownerId, "claude");
    expect(post).toEqual([]);
  });

  it("heartbeat advances last_heartbeat", async () => {
    const id = runtimeId();
    await runtimes.create({ id, daemon_id: dId, cli: "claude" });
    expect((await runtimes.findById(id))?.last_heartbeat).toBeUndefined();
    await runtimes.heartbeat(id);
    expect((await runtimes.findById(id))?.last_heartbeat).toBeInstanceOf(Date);
  });

  it("update applies partial patches and merges capabilities jsonb", async () => {
    const id = runtimeId();
    await runtimes.create({ id, daemon_id: dId, cli: "claude" });
    const updated = await runtimes.update(id, {
      cli_version: "2.0.0",
      capabilities: { models: ["opus", "sonnet"] },
    });
    expect(updated.cli_version).toBe("2.0.0");
    expect(updated.capabilities).toEqual({ models: ["opus", "sonnet"] });
  });

  it("runtime survives daemon soft-delete; hard-delete cascades", async () => {
    const id = runtimeId();
    await runtimes.create({ id, daemon_id: dId, cli: "claude" });
    expect(await runtimes.findById(id)).toBeDefined();

    // Revoke alone is soft-delete on daemon; row stays. Runtime survives.
    await daemons.revoke(dId);
    expect(await runtimes.findById(id)).toBeDefined();

    // Hard delete the daemon → ON DELETE CASCADE drops the runtime.
    await pool.query(`DELETE FROM daemon WHERE id = $1`, [dId]);
    expect(await runtimes.findById(id)).toBeUndefined();
  });
});
