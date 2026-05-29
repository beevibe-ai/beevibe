/**
 * Integration test: /negotiation/:id review endpoint.
 * Real Postgres via DATABASE_URL_TEST. Seeds two team agents, a
 * negotiation with rounds, and exercises the GET shape (names, rounds,
 * escalation linkage, auth gates).
 */

import express from "express";
import { json } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresEscalationRepository,
  PostgresNegotiationRepository,
  PostgresNegotiationRoundRepository,
  PostgresPersonRepository,
  PostgresSessionRepository,
  type Pool,
} from "@beevibe/core/adapters/postgres";
import { provisionAgent, provisionUser } from "@beevibe/core/auth";
import { NegotiationService } from "@beevibe/core/services/negotiation-service";
import {
  DEFAULT_RUNTIME_CONFIG,
  agentId,
  escalationId,
  negotiationId,
  personId,
  sessionId,
} from "@beevibe/core";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createNegotiationRouter } from "./negotiation.js";

describe("negotiation routes — integration", () => {
  let pool: Pool;
  let agentRepo: PostgresAgentRepository;
  let personRepo: PostgresPersonRepository;
  let coreMemoryRepo: PostgresCoreMemoryRepository;
  let sessionRepo: PostgresSessionRepository;
  let negotiationRepo: PostgresNegotiationRepository;
  let negotiationRoundRepo: PostgresNegotiationRoundRepository;
  let escalationRepo: PostgresEscalationRepository;
  let negotiationService: NegotiationService;

  beforeAll(() => {
    pool = createTestPool();
    agentRepo = new PostgresAgentRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
    coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
    sessionRepo = new PostgresSessionRepository(pool);
    negotiationRepo = new PostgresNegotiationRepository(pool);
    negotiationRoundRepo = new PostgresNegotiationRoundRepository(pool);
    escalationRepo = new PostgresEscalationRepository(pool);
    negotiationService = new NegotiationService({
      negotiationRepo,
      negotiationRoundRepo,
      agentRepo,
      escalationRepo,
    });
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
    app.use(
      "/negotiation",
      createNegotiationRouter({
        authMiddleware: createAuthMiddleware({ agentRepo, personRepo }),
        negotiationService,
      }),
    );
    return app;
  }

  async function seedNegotiation(opts: { escalated?: boolean } = {}): Promise<{
    humanApiKey: string;
    ownerId: string;
    initiator: { id: string };
    counterparty: { id: string };
    negotiationId: string;
    escalationId?: string;
  }> {
    const owner = await provisionUser(
      { personRepo },
      { id: personId(), name: "Owner", email: `owner-${Date.now()}@example.com` },
    );
    const teamA = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Team A",
        owner_id: owner.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    const teamB = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Team B",
        owner_id: owner.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );

    const sa = await sessionRepo.create({
      id: sessionId(),
      agent_id: teamA.agent.id,
      type: "task",
      status: "succeeded",
      intent: "i",
    });
    const sb = await sessionRepo.create({
      id: sessionId(),
      agent_id: teamB.agent.id,
      type: "mesh_negotiate",
      status: "succeeded",
      intent: "j",
    });

    const neg = await negotiationRepo.create({
      id: negotiationId(),
      initiator_agent_id: teamA.agent.id,
      initiator_session_id: sa.id,
      counterparty_agent_id: teamB.agent.id,
      counterparty_session_id: sb.id,
      max_rounds: 5,
    });

    const t = Date.now();
    await negotiationRoundRepo.create({
      id: `round_${t}_1`,
      negotiation_id: neg.id,
      round_number: 1,
      from_agent_id: teamA.agent.id,
      decision: "propose",
      message: "A opening proposal",
    });
    await negotiationRoundRepo.create({
      id: `round_${t}_2`,
      negotiation_id: neg.id,
      round_number: 2,
      from_agent_id: teamB.agent.id,
      decision: "counter",
      message: "B counter",
    });

    let esc: { id: string } | undefined;
    if (opts.escalated) {
      await negotiationRepo.update(neg.id, { status: "escalated" });
      const escRow = await escalationRepo.create({
        id: escalationId(),
        negotiation_id: neg.id,
        initiator_session_id: sa.id,
        counterparty_session_id: sb.id,
        summary: "Stuck.",
        initiator_open_questions: [],
        escalated_by_role: "counterparty",
      });
      esc = { id: escRow.id };
    }

    return {
      humanApiKey: owner.apiKey,
      ownerId: owner.person.id,
      initiator: { id: teamA.agent.id },
      counterparty: { id: teamB.agent.id },
      negotiationId: neg.id,
      escalationId: esc?.id,
    };
  }

  it("GET /:id returns rounds + agent names; no escalation when active", async () => {
    const seed = await seedNegotiation();

    const res = await request(makeApp())
      .get(`/negotiation/${seed.negotiationId}`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.negotiation.id).toBe(seed.negotiationId);
    expect(res.body.negotiation.initiator_agent_name).toBe("Team A");
    expect(res.body.negotiation.counterparty_agent_name).toBe("Team B");
    expect(res.body.negotiation.rounds).toHaveLength(2);
    expect(res.body.negotiation.rounds[0].message).toBe("A opening proposal");
    expect(res.body.negotiation.rounds[1].decision).toBe("counter");
    expect(res.body.negotiation.escalation_id).toBeUndefined();
    expect(res.body.negotiation.status).toBe("active");
  });

  it("GET /:id includes escalation_id when the negotiation was escalated", async () => {
    const seed = await seedNegotiation({ escalated: true });

    const res = await request(makeApp())
      .get(`/negotiation/${seed.negotiationId}`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.negotiation.status).toBe("escalated");
    expect(res.body.negotiation.escalation_id).toBe(seed.escalationId);
  });

  it("GET /:id → 404 for unknown id", async () => {
    const seed = await seedNegotiation();
    const res = await request(makeApp())
      .get("/negotiation/neg_does_not_exist")
      .set("Authorization", `Bearer ${seed.humanApiKey}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("negotiation_not_found");
  });

  it("agent caller (bv_a_) → 403", async () => {
    const seed = await seedNegotiation();
    const owner = await personRepo.findByApiKey(seed.humanApiKey);
    expect(owner).toBeDefined();

    const otherTeam = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Other team",
        owner_id: owner!.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );

    const res = await request(makeApp())
      .get(`/negotiation/${seed.negotiationId}`)
      .set("Authorization", `Bearer ${otherTeam.apiKey}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("missing token → 401", async () => {
    const res = await request(makeApp()).get("/negotiation/neg_x");
    expect(res.status).toBe(401);
  });
});
