/**
 * Real-Postgres regression test for `getMeshOverview` — catches SQL errors
 * (ambiguous columns, malformed fragments) that the mock-Pool unit tests
 * in mesh.test.ts cannot. Each window variant is executed against a freshly
 * seeded DB so any future refactor to the WHERE fragments must keep all
 * four shapes runnable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  personId,
  sessionId,
} from "@beevibe/core";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import { getMeshOverview } from "./mesh.js";
import { MESH_WINDOWS } from "./types.js";

describe("getMeshOverview — integration", () => {
  let pool: Pool;
  let agentRepo: PostgresAgentRepository;
  let personRepo: PostgresPersonRepository;
  let coreMemoryRepo: PostgresCoreMemoryRepository;
  let sessionRepo: PostgresSessionRepository;
  let negotiationRepo: PostgresNegotiationRepository;
  let negotiationRoundRepo: PostgresNegotiationRoundRepository;

  beforeAll(() => {
    pool = createTestPool();
    agentRepo = new PostgresAgentRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
    coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
    sessionRepo = new PostgresSessionRepository(pool);
    negotiationRepo = new PostgresNegotiationRepository(pool);
    negotiationRoundRepo = new PostgresNegotiationRoundRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedMeshActivity(): Promise<{ initiatorId: string; counterpartyId: string }> {
    const owner = await provisionUser(
      { personRepo },
      { id: personId(), name: "Owner", email: `owner-${Date.now()}@example.com` },
    );
    const a = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Team A",
        owner_id: owner.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    const b = await provisionAgent(
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
      id: `round_${Date.now()}_1`,
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

    return { initiatorId: a.agent.id, counterpartyId: b.agent.id };
  }

  it.each([...MESH_WINDOWS])("runs cleanly with window=%s", async (window) => {
    const seed = await seedMeshActivity();
    const overview = await getMeshOverview(pool, window);

    expect(overview.asks.length).toBeGreaterThanOrEqual(2);
    const ids = overview.graph.nodes.map((n) => n.id).sort();
    expect(ids).toEqual([seed.initiatorId, seed.counterpartyId].sort());
    expect(overview.graph.edges.length).toBeGreaterThan(0);
    expect(overview.summary.in_flight).toBeGreaterThan(0);
  });
});
