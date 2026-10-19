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
  createStreamAuthMiddleware,
  requireDaemon,
  requireHuman,
  streamTokenAdapter,
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

  it("requireHuman allows a bv_u_ caller through to the handler", async () => {
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
      .get("/human-only")
      .set("Authorization", `Bearer ${alice.apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.caller.source).toBe("human");
    expect(res.body.caller.personId).toBe(alice.person.id);
    expect(res.body.caller.agentId).toBe(team.agent.id);
  });

  it("requireHuman rejects an agent caller", async () => {
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
      .get("/human-only")
      .set("Authorization", `Bearer ${team.apiKey}`);
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

/**
 * `?token=` → `Authorization: Bearer` adapter. EventSource can't set
 * headers, so /api/stream carries the token in the query string; the
 * adapter is what lets the header-only auth middleware behind it work
 * unchanged. Pure request rewriting — no DB needed.
 */
describe("streamTokenAdapter", () => {
  function adapterApp() {
    const app = express();
    app.use(streamTokenAdapter);
    app.get("/echo", (req, res) => {
      res.json({ authorization: req.headers.authorization ?? null });
    });
    return app;
  }

  it("copies ?token= into the Authorization header", async () => {
    const res = await request(adapterApp()).get("/echo?token=bv_u_abc");
    expect(res.body.authorization).toBe("Bearer bv_u_abc");
  });

  it("leaves an existing Authorization header alone", async () => {
    const res = await request(adapterApp())
      .get("/echo?token=bv_u_from_query")
      .set("Authorization", "Bearer bv_u_from_header");
    expect(res.body.authorization).toBe("Bearer bv_u_from_header");
  });

  it("is a no-op with no token and no header", async () => {
    const res = await request(adapterApp()).get("/echo");
    expect(res.body.authorization).toBeNull();
  });

  it("ignores a repeated token= (express parses it as an array)", async () => {
    const res = await request(adapterApp()).get("/echo?token=a&token=b");
    expect(res.body.authorization).toBeNull();
  });
});

describe("createStreamAuthMiddleware — integration", () => {
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

  function streamApp() {
    const app = express();
    app.use(createStreamAuthMiddleware({ agentRepo, personRepo, daemonRepo }));
    app.get("/stream", (req, res) => {
      res.json({ caller: req.caller });
    });
    return app;
  }

  async function seedHuman() {
    const alice = await provisionUser(
      { personRepo },
      { id: personId(), name: "Alice", email: "alice@example.com" },
    );
    await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Alice's Team Agent",
        owner_id: alice.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    return alice;
  }

  it("authenticates an EventSource request carrying ?token=", async () => {
    const alice = await seedHuman();
    const res = await request(streamApp()).get(`/stream?token=${alice.apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.caller.source).toBe("human");
    expect(res.body.caller.personId).toBe(alice.person.id);
  });

  it("still accepts the header form", async () => {
    const alice = await seedHuman();
    const res = await request(streamApp())
      .get("/stream")
      .set("Authorization", `Bearer ${alice.apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.caller.source).toBe("human");
  });

  it("401s a query token that resolves to nobody", async () => {
    const res = await request(streamApp()).get("/stream?token=bv_u_nope");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
  });

  it("401s with neither header nor query token", async () => {
    const res = await request(streamApp()).get("/stream");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_authorization");
  });
});
