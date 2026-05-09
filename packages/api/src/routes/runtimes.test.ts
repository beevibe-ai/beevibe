/**
 * /runtimes panel surface — integration tests against real Postgres.
 *
 * Covers:
 *   - GET /runtimes shape (daemons + nested runtimes + online flag)
 *   - empty list for a user with no daemons
 *   - tenant isolation (Bob can't see Alice's daemons)
 *   - online status reflects DaemonHub registration
 *   - POST /runtimes/:id/revoke marks revoked_at + idempotency
 *   - 404 for unknown daemon, 404 for not-yours daemon
 *   - 403 for daemon-only callers (bv_d_)
 */

import express, { json } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresDaemonRepository,
  PostgresPersonRepository,
  PostgresRuntimeRepository,
  type Pool,
} from "@beevibe/core/adapters/postgres";
import {
  generateDaemonApiKey,
  hashDaemonToken,
  provisionAgent,
  provisionUser,
} from "@beevibe/core/auth";
import {
  DEFAULT_RUNTIME_CONFIG,
  agentId,
  daemonId,
  personId,
  runtimeId,
} from "@beevibe/core";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import { createAuthMiddleware } from "../auth/middleware.js";
import { DaemonHub, type DaemonClient } from "../runtime/hub.js";
import { createRuntimesRouter } from "./runtimes.js";

describe("/runtimes panel surface — integration", () => {
  let pool: Pool;
  let agentRepo: PostgresAgentRepository;
  let personRepo: PostgresPersonRepository;
  let daemonRepo: PostgresDaemonRepository;
  let runtimeRepo: PostgresRuntimeRepository;
  let coreMemoryRepo: PostgresCoreMemoryRepository;
  let hub: DaemonHub;

  beforeAll(() => {
    pool = createTestPool();
    agentRepo = new PostgresAgentRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
    daemonRepo = new PostgresDaemonRepository(pool);
    runtimeRepo = new PostgresRuntimeRepository(pool);
    coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    hub = new DaemonHub();
  });

  afterAll(async () => {
    await pool.end();
  });

  function makeApp() {
    const app = express();
    app.use(json());
    app.use(
      "/runtimes",
      createRuntimesRouter({
        authMiddleware: createAuthMiddleware({ agentRepo, personRepo, daemonRepo }),
        daemonRepo,
        runtimeRepo,
        hub,
      }),
    );
    return app;
  }

  async function makePersonWithAgent(name: string, email: string) {
    const person = await provisionUser(
      { personRepo },
      { id: personId(), name, email },
    );
    await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: `${name}'s Agent`,
        owner_id: person.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    return person;
  }

  async function makeDaemonWithRuntimes(
    ownerPersonId: string,
    deviceName: string,
    clis: string[],
  ): Promise<{ daemonId: string; daemonToken: string; runtimeIds: string[] }> {
    const dId = daemonId();
    const token = generateDaemonApiKey();
    await daemonRepo.create({
      id: dId,
      owner_person_id: ownerPersonId,
      external_id: deviceName.toLowerCase().replace(/\s+/g, "-"),
      device_name: deviceName,
      token_hash: hashDaemonToken(token),
    });
    const runtimeIds: string[] = [];
    for (const cli of clis) {
      const rId = runtimeId();
      await runtimeRepo.create({ id: rId, daemon_id: dId, cli });
      runtimeIds.push(rId);
    }
    return { daemonId: dId, daemonToken: token, runtimeIds };
  }

  function fakeClient(daemon: string, runtimes: readonly string[]): DaemonClient {
    return {
      daemonId: daemon,
      runtimeIds: runtimes,
      send: () => {},
    };
  }

  /* ─── GET /runtimes ─────────────────────────────────────────────── */

  describe("GET /runtimes", () => {
    it("returns empty array for a user with no daemons", async () => {
      const alice = await makePersonWithAgent("Alice", "alice@example.com");
      const res = await request(makeApp())
        .get("/runtimes")
        .set("Authorization", `Bearer ${alice.apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, daemons: [] });
    });

    it("lists the caller's daemons + nested runtimes", async () => {
      const alice = await makePersonWithAgent("Alice", "alice@example.com");
      const { daemonId: dId, runtimeIds } = await makeDaemonWithRuntimes(
        alice.person.id,
        "MacBook Pro",
        ["claude", "codex"],
      );

      const res = await request(makeApp())
        .get("/runtimes")
        .set("Authorization", `Bearer ${alice.apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.daemons).toHaveLength(1);
      const d = res.body.daemons[0];
      expect(d.id).toBe(dId);
      expect(d.device_name).toBe("MacBook Pro");
      expect(d.runtimes).toHaveLength(2);
      const cliNames = d.runtimes.map((r: { cli: string }) => r.cli).sort();
      expect(cliNames).toEqual(["claude", "codex"]);
      expect(runtimeIds.sort()).toEqual(
        d.runtimes.map((r: { id: string }) => r.id).sort(),
      );
      // Both runtimes are offline (no hub registration in this test).
      for (const r of d.runtimes) {
        expect(r.online).toBe(false);
      }
    });

    it("reflects hub registration via the `online` flag", async () => {
      const alice = await makePersonWithAgent("Alice", "alice@example.com");
      const { daemonId: dId, runtimeIds } = await makeDaemonWithRuntimes(
        alice.person.id,
        "MacBook",
        ["claude"],
      );
      // Register a fake hub client for this daemon's only runtime.
      hub.register(fakeClient(dId, runtimeIds));

      const res = await request(makeApp())
        .get("/runtimes")
        .set("Authorization", `Bearer ${alice.apiKey}`);

      expect(res.status).toBe(200);
      expect(res.body.daemons[0].runtimes[0].online).toBe(true);
    });

    it("excludes other users' daemons (tenant isolation)", async () => {
      const alice = await makePersonWithAgent("Alice", "alice@example.com");
      const bob = await makePersonWithAgent("Bob", "bob@example.com");
      await makeDaemonWithRuntimes(alice.person.id, "Alice's Mac", ["claude"]);
      await makeDaemonWithRuntimes(bob.person.id, "Bob's Mac", ["claude"]);

      const aliceRes = await request(makeApp())
        .get("/runtimes")
        .set("Authorization", `Bearer ${alice.apiKey}`);
      const bobRes = await request(makeApp())
        .get("/runtimes")
        .set("Authorization", `Bearer ${bob.apiKey}`);

      expect(aliceRes.body.daemons).toHaveLength(1);
      expect(aliceRes.body.daemons[0].device_name).toBe("Alice's Mac");
      expect(bobRes.body.daemons).toHaveLength(1);
      expect(bobRes.body.daemons[0].device_name).toBe("Bob's Mac");
    });

    it("excludes revoked daemons", async () => {
      const alice = await makePersonWithAgent("Alice", "alice@example.com");
      const { daemonId: dId } = await makeDaemonWithRuntimes(
        alice.person.id,
        "Old Mac",
        ["claude"],
      );
      await daemonRepo.revoke(dId);

      const res = await request(makeApp())
        .get("/runtimes")
        .set("Authorization", `Bearer ${alice.apiKey}`);

      expect(res.body.daemons).toEqual([]);
    });

    it("rejects bv_d_ daemon callers (bv_u_ only)", async () => {
      const alice = await makePersonWithAgent("Alice", "alice@example.com");
      const { daemonToken } = await makeDaemonWithRuntimes(alice.person.id, "Mac", [
        "claude",
      ]);

      const res = await request(makeApp())
        .get("/runtimes")
        .set("Authorization", `Bearer ${daemonToken}`);

      expect(res.status).toBe(403);
    });

    it("rejects unauthenticated calls (401)", async () => {
      const res = await request(makeApp()).get("/runtimes");
      expect(res.status).toBe(401);
    });
  });

  /* ─── POST /runtimes/:id/revoke ─────────────────────────────────── */

  describe("POST /runtimes/:id/revoke", () => {
    it("revokes the caller's daemon", async () => {
      const alice = await makePersonWithAgent("Alice", "alice@example.com");
      const { daemonId: dId } = await makeDaemonWithRuntimes(alice.person.id, "Mac", [
        "claude",
      ]);

      const res = await request(makeApp())
        .post(`/runtimes/${dId}/revoke`)
        .set("Authorization", `Bearer ${alice.apiKey}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        daemon_id: dId,
        already_revoked: false,
      });

      const after = await daemonRepo.findById(dId);
      expect(after?.revoked_at).toBeTruthy();
    });

    it("is idempotent on already-revoked daemons", async () => {
      const alice = await makePersonWithAgent("Alice", "alice@example.com");
      const { daemonId: dId } = await makeDaemonWithRuntimes(alice.person.id, "Mac", [
        "claude",
      ]);
      await daemonRepo.revoke(dId);

      const res = await request(makeApp())
        .post(`/runtimes/${dId}/revoke`)
        .set("Authorization", `Bearer ${alice.apiKey}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.already_revoked).toBe(true);
    });

    it("returns 404 for unknown daemon ids", async () => {
      const alice = await makePersonWithAgent("Alice", "alice@example.com");
      const res = await request(makeApp())
        .post(`/runtimes/${daemonId()}/revoke`)
        .set("Authorization", `Bearer ${alice.apiKey}`)
        .send({});

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("daemon_not_found");
    });

    it("returns 404 (not 403) when revoking another user's daemon — no existence leak", async () => {
      const alice = await makePersonWithAgent("Alice", "alice@example.com");
      const bob = await makePersonWithAgent("Bob", "bob@example.com");
      const { daemonId: bobDaemon } = await makeDaemonWithRuntimes(
        bob.person.id,
        "Bob's Mac",
        ["claude"],
      );

      const res = await request(makeApp())
        .post(`/runtimes/${bobDaemon}/revoke`)
        .set("Authorization", `Bearer ${alice.apiKey}`)
        .send({});

      expect(res.status).toBe(404);
      // Bob's daemon was NOT revoked.
      const after = await daemonRepo.findById(bobDaemon);
      expect(after?.revoked_at).toBeUndefined();
    });

    it("rejects bv_d_ daemon callers (bv_u_ only)", async () => {
      const alice = await makePersonWithAgent("Alice", "alice@example.com");
      const { daemonId: dId, daemonToken } = await makeDaemonWithRuntimes(
        alice.person.id,
        "Mac",
        ["claude"],
      );

      const res = await request(makeApp())
        .post(`/runtimes/${dId}/revoke`)
        .set("Authorization", `Bearer ${daemonToken}`)
        .send({});

      expect(res.status).toBe(403);
    });
  });
});
