/**
 * Real-Postgres tests for `getMeshOverview` — the mock-Pool tests in
 * mesh.test.ts can't catch SQL errors like ambiguous columns.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresNegotiationRepository,
  PostgresNegotiationRoundRepository,
  PostgresPersonRepository,
  PostgresSessionRepository,
  type Pool,
} from "@beevibe/core/adapters/postgres";
import { provisionAgent, provisionUser } from "@beevibe/core/auth";
import {
  DEFAULT_RUNTIME_CONFIG,
  agentId,
  negotiationId,
  negotiationRoundId,
  personId,
  sessionId,
} from "@beevibe/core";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import { getMeshOverview } from "./mesh.js";
import { MESH_WINDOWS } from "./types.js";

describe("getMeshOverview — integration", () => {
  let pool: Pool;
  let initiatorId: string;
  let counterpartyId: string;

  beforeAll(async () => {
    pool = createTestPool();
    const agentRepo = new PostgresAgentRepository(pool);
    const personRepo = new PostgresPersonRepository(pool);
    const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
    const sessionRepo = new PostgresSessionRepository(pool);
    const negotiationRepo = new PostgresNegotiationRepository(pool);
    const negotiationRoundRepo = new PostgresNegotiationRoundRepository(pool);

    await truncateAll(pool);

    const owner = await provisionUser(
      { personRepo },
      { id: personId(), name: "Owner", email: `owner-${Date.now()}@example.com` },
    );
    const provisionTeam = (name: string) =>
      provisionAgent(
        { agentRepo, coreMemoryRepo },
        {
          id: agentId(),
          name,
          owner_id: owner.person.id,
          hierarchy_level: "team",
          runtime_config: DEFAULT_RUNTIME_CONFIG,
        },
      );
    const a = await provisionTeam("Team A");
    const b = await provisionTeam("Team B");

    const sa = await sessionRepo.create({
      id: sessionId(),
      agent_id: a.agent.id,
      type: "task",
      status: "succeeded",
      intent: "i",
    });
    const sb = await sessionRepo.create({
      id: sessionId(),
      agent_id: b.agent.id,
      type: "mesh_negotiate",
      status: "succeeded",
      intent: "j",
    });

    const neg = await negotiationRepo.create({
      id: negotiationId(),
      initiator_agent_id: a.agent.id,
      initiator_session_id: sa.id,
      counterparty_agent_id: b.agent.id,
      counterparty_session_id: sb.id,
      max_rounds: 5,
    });
    await negotiationRoundRepo.create({
      id: negotiationRoundId(),
      negotiation_id: neg.id,
      round_number: 1,
      from_agent_id: a.agent.id,
      decision: "propose",
      message: "Opening proposal",
    });

    await sessionRepo.create({
      id: sessionId(),
      agent_id: b.agent.id,
      type: "mesh_ask",
      status: "running",
      started_at: new Date(),
      intent: `<mesh-ask from="${a.agent.id}">What is the SLA?</mesh-ask>`,
      caller_agent_id: a.agent.id,
    });

    initiatorId = a.agent.id;
    counterpartyId = b.agent.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it.each([...MESH_WINDOWS])("runs cleanly with window=%s", async (window) => {
    const overview = await getMeshOverview(pool, window);

    expect(overview.asks.length).toBeGreaterThanOrEqual(2);
    const ids = overview.graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([initiatorId, counterpartyId].sort());
    expect(overview.graph.edges.length).toBeGreaterThan(0);
    expect(overview.summary.in_flight).toBeGreaterThan(0);
  });
});
