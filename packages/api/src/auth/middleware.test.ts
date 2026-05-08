/**
 * Bearer auth middleware, integration-tested against real Postgres so the
 * lookupApiKey path is exercised end-to-end. Mirrors the auth integration
 * test pattern from @beevibe/core.
 */
import express, { json, type Request, type Response } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresDaemonRepository,
  PostgresPersonRepository,
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
} from "@beevibe/core";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import {
  createAuthMiddleware,
  requireDaemon,
  requireHuman,
} from "./middleware.js";

describe("auth middleware — integration", () => {
  let pool: Pool;
  let agentRepo: PostgresAgentRepository;
  let personRepo: PostgresPersonRepository;
  let daemonRepo: PostgresDaemonRepository;
  let coreMemoryRepo: PostgresCoreMemoryRepository;

  beforeAll(() => {
    pool = createTestPool();
    agentRepo = new PostgresAgentRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
    daemonRepo = new PostgresDaemonRepository(pool);
    coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  function makeApp() {
    const app = express();
    app.use(json());
    app.use(createAuthMiddleware({ agentRepo, personRepo, daemonRepo }));
    app.get("/protected", (req, res) => {
      res.json({ caller: req.caller });
    });
    app.get("/daemon-only", (req: Request, res: Response) => {
      if (!requireDaemon(req, res)) return;
      res.json({ caller: req.caller });
    });
    app.get("/human-only", (req: Request, res: Response) => {
      if (!requireHuman(req, res)) return;
      res.json({ caller: req.caller });
    });
    return app;
  }

  it("resolves a bv_a_ token to source='agent' caller", async () => {
    const alice = await provisionUser(
      { personRepo },
      { id: personId(), name: "Alice", email: "alice@example.com" },
    );
    const team = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Alice's Team Agent",
        owner_id: alice.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );

    const res = await request(makeApp())
      .get("/protected")
      .set("Authorization", `Bearer ${team.apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.caller).toEqual({
      source: "agent",
      agentId: team.agent.id,
      hierarchyLevel: "team",
    });
  });

  it("resolves a bv_u_ token to source='human' caller via findUserAgent", async () => {
    const alice = await provisionUser(
      { personRepo },
      { id: personId(), name: "Alice", email: "alice@example.com" },
    );
    const team = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Alice's Team Agent",
        owner_id: alice.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );

    const res = await request(makeApp())
      .get("/protected")
      .set("Authorization", `Bearer ${alice.apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.caller).toEqual({
      source: "human",
      agentId: team.agent.id,
      hierarchyLevel: "team",
      personId: alice.person.id,
    });
  });

  it("returns 401 missing_authorization when Authorization header absent", async () => {
    const res = await request(makeApp()).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_authorization");
  });

  it("returns 401 malformed_authorization when header is not Bearer-shaped", async () => {
    const res = await request(makeApp())
      .get("/protected")
      .set("Authorization", "Basic abc123");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("malformed_authorization");
  });

  it("returns 401 invalid_token when token is unrecognized prefix", async () => {
    const res = await request(makeApp())
      .get("/protected")
      .set("Authorization", "Bearer not_a_real_prefix_abc");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });

  it("returns 401 invalid_token when bv_a_ token doesn't exist in DB", async () => {
    const res = await request(makeApp())
      .get("/protected")
      .set("Authorization", "Bearer bv_a_nonexistentnonexistentnnnn");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });

  it("returns 401 invalid_token when bv_u_ person has no primary agent", async () => {
    // Person with no agent → findUserAgent returns undefined → 401
    const alice = await provisionUser(
      { personRepo },
      { id: personId(), name: "Alice (no agent)", email: "alice2@example.com" },
    );

    const res = await request(makeApp())
      .get("/protected")
      .set("Authorization", `Bearer ${alice.apiKey}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });

  it("resolves a bv_d_ token to source='daemon' caller via daemonRepo", async () => {
    const alice = await provisionUser(
      { personRepo },
      { id: personId(), name: "Alice", email: "alice@example.com" },
    );
    const token = generateDaemonApiKey();
    const id = daemonId();
    await daemonRepo.create({
      id,
      owner_person_id: alice.person.id,
      external_id: "macbook-pro",
      device_name: "MacBook Pro",
      token_hash: hashDaemonToken(token),
    });

    const res = await request(makeApp())
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.caller).toEqual({
      source: "daemon",
      daemonId: id,
      ownerPersonId: alice.person.id,
    });
  });

  it("requireDaemon allows daemon callers and rejects human/agent", async () => {
    const alice = await provisionUser(
      { personRepo },
      { id: personId(), name: "Alice", email: "alice@example.com" },
    );
    const team = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Alice's Team Agent",
        owner_id: alice.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    const token = generateDaemonApiKey();
    await daemonRepo.create({
      id: daemonId(),
      owner_person_id: alice.person.id,
      external_id: "macbook-pro",
      device_name: "MacBook Pro",
      token_hash: hashDaemonToken(token),
    });

    const daemonRes = await request(makeApp())
      .get("/daemon-only")
      .set("Authorization", `Bearer ${token}`);
    expect(daemonRes.status).toBe(200);
    expect(daemonRes.body.caller.source).toBe("daemon");

    const humanRes = await request(makeApp())
      .get("/daemon-only")
      .set("Authorization", `Bearer ${alice.apiKey}`);
    expect(humanRes.status).toBe(403);
    expect(humanRes.body.error).toBe("daemon_required");

    const agentRes = await request(makeApp())
      .get("/daemon-only")
      .set("Authorization", `Bearer ${team.apiKey}`);
    expect(agentRes.status).toBe(403);
    expect(agentRes.body.error).toBe("daemon_required");
  });

  it("requireHuman rejects daemon callers", async () => {
    const alice = await provisionUser(
      { personRepo },
      { id: personId(), name: "Alice", email: "alice@example.com" },
    );
    const token = generateDaemonApiKey();
    await daemonRepo.create({
      id: daemonId(),
      owner_person_id: alice.person.id,
      external_id: "macbook-pro",
      device_name: "MacBook Pro",
      token_hash: hashDaemonToken(token),
    });

    const res = await request(makeApp())
      .get("/human-only")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("revoked daemon tokens fail with 401 invalid_token", async () => {
    const alice = await provisionUser(
      { personRepo },
      { id: personId(), name: "Alice", email: "alice@example.com" },
    );
    const token = generateDaemonApiKey();
    const id = daemonId();
    await daemonRepo.create({
      id,
      owner_person_id: alice.person.id,
      external_id: "macbook-pro",
      device_name: "MacBook Pro",
      token_hash: hashDaemonToken(token),
    });
    await daemonRepo.revoke(id);

    const res = await request(makeApp())
      .get("/protected")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });
});
