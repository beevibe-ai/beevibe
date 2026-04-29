/**
 * Bearer auth middleware, integration-tested against real Postgres so the
 * lookupApiKey path is exercised end-to-end. Mirrors the auth integration
 * test pattern from @beevibe/core.
 */
import express, { json } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresPersonRepository,
  type Pool,
} from "@beevibe/core/adapters/postgres";
import { provisionAgent, provisionUser } from "@beevibe/core/auth";
import { DEFAULT_RUNTIME_CONFIG, agentId, personId } from "@beevibe/core";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import { createAuthMiddleware } from "./middleware.js";

describe("auth middleware — integration", () => {
  let pool: Pool;
  let agentRepo: PostgresAgentRepository;
  let personRepo: PostgresPersonRepository;
  let coreMemoryRepo: PostgresCoreMemoryRepository;

  beforeAll(() => {
    pool = createTestPool();
    agentRepo = new PostgresAgentRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
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
    app.use(createAuthMiddleware({ agentRepo, personRepo }));
    app.get("/protected", (req, res) => {
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
});
