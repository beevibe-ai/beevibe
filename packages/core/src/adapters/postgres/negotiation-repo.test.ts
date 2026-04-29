import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import {
  agentId,
  negotiationId,
  negotiationRoundId,
  personId,
  sessionId,
  taskId,
} from "../../domain/ids.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import type { Pool } from "./client.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import {
  PostgresNegotiationRepository,
  PostgresNegotiationRoundRepository,
} from "./negotiation-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresSessionRepository } from "./session-repo.js";
import { PostgresTaskRepository } from "./task-repo.js";

describe("PostgresNegotiationRepository", () => {
  let pool: Pool;
  let negotiations: PostgresNegotiationRepository;
  let rounds: PostgresNegotiationRoundRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let sessions: PostgresSessionRepository;
  let tasks: PostgresTaskRepository;

  let initiatorAgent: string;
  let counterpartyAgent: string;
  let initiatorSession: string;
  let counterpartySession: string;
  let task: string;

  beforeAll(() => {
    pool = createTestPool();
    negotiations = new PostgresNegotiationRepository(pool);
    rounds = new PostgresNegotiationRoundRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
    sessions = new PostgresSessionRepository(pool);
    tasks = new PostgresTaskRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Owner" });
    const a = await agents.create({
      id: agentId(),
      name: "Initiator",
      owner_id: owner.id,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    const b = await agents.create({
      id: agentId(),
      name: "Counterparty",
      owner_id: owner.id,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    initiatorAgent = a.id;
    counterpartyAgent = b.id;

    const sa = await sessions.create({
      id: sessionId(),
      agent_id: initiatorAgent,
      type: "task",
      status: "running",
      intent: "i",
    });
    const sb = await sessions.create({
      id: sessionId(),
      agent_id: counterpartyAgent,
      type: "mesh_negotiate",
      status: "running",
      intent: "j",
    });
    initiatorSession = sa.id;
    counterpartySession = sb.id;

    const t = await tasks.create({
      id: taskId(),
      title: "T",
      priority: "medium",
      creator_id: owner.id,
      creator_type: "person",
    });
    task = t.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("create + findById round-trips with status='active', rounds_completed=0 by default", async () => {
    const id = negotiationId();
    const neg = await negotiations.create({
      id,
      initiator_agent_id: initiatorAgent,
      initiator_session_id: initiatorSession,
      counterparty_agent_id: counterpartyAgent,
      task_id: task,
      max_rounds: 5,
    });
    expect(neg.id).toBe(id);
    expect(neg.status).toBe("active");
    expect(neg.rounds_completed).toBe(0);
    expect(neg.max_rounds).toBe(5);
    expect(neg.task_id).toBe(task);

    const found = await negotiations.findById(id);
    expect(found).toEqual(neg);
  });

  it("update mutates status / rounds_completed / counterparty_session_id and bumps updated_at", async () => {
    const neg = await negotiations.create({
      id: negotiationId(),
      initiator_agent_id: initiatorAgent,
      initiator_session_id: initiatorSession,
      counterparty_agent_id: counterpartyAgent,
      max_rounds: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    const updated = await negotiations.update(neg.id, {
      counterparty_session_id: counterpartySession,
      rounds_completed: 2,
    });
    expect(updated.counterparty_session_id).toBe(counterpartySession);
    expect(updated.rounds_completed).toBe(2);
    expect(updated.status).toBe("active");
    expect(updated.updated_at.getTime()).toBeGreaterThan(neg.updated_at.getTime());

    const escalated = await negotiations.update(neg.id, { status: "escalated" });
    expect(escalated.status).toBe("escalated");
  });

  it("findActiveBetween returns the latest active row for the (initiator, counterparty) pair", async () => {
    const oldNeg = await negotiations.create({
      id: negotiationId(),
      initiator_agent_id: initiatorAgent,
      initiator_session_id: initiatorSession,
      counterparty_agent_id: counterpartyAgent,
      max_rounds: 5,
    });
    await negotiations.update(oldNeg.id, { status: "accepted" });

    const newNeg = await negotiations.create({
      id: negotiationId(),
      initiator_agent_id: initiatorAgent,
      initiator_session_id: initiatorSession,
      counterparty_agent_id: counterpartyAgent,
      max_rounds: 5,
    });

    const active = await negotiations.findActiveBetween(initiatorAgent, counterpartyAgent);
    expect(active?.id).toBe(newNeg.id);
  });

  it("rounds CRUD + listByNegotiation order + findLatest + UNIQUE round_number", async () => {
    const neg = await negotiations.create({
      id: negotiationId(),
      initiator_agent_id: initiatorAgent,
      initiator_session_id: initiatorSession,
      counterparty_agent_id: counterpartyAgent,
      max_rounds: 5,
    });

    await rounds.create({
      id: negotiationRoundId(),
      negotiation_id: neg.id,
      round_number: 1,
      from_agent_id: initiatorAgent,
      decision: "propose",
      message: "v1",
    });
    await rounds.create({
      id: negotiationRoundId(),
      negotiation_id: neg.id,
      round_number: 2,
      from_agent_id: counterpartyAgent,
      decision: "counter",
      message: "v1c",
    });
    await rounds.create({
      id: negotiationRoundId(),
      negotiation_id: neg.id,
      round_number: 3,
      from_agent_id: initiatorAgent,
      decision: "accept",
      message: "ok",
    });

    const list = await rounds.listByNegotiation(neg.id);
    expect(list.map((r) => r.round_number)).toEqual([1, 2, 3]);

    const latest = await rounds.findLatest(neg.id);
    expect(latest?.round_number).toBe(3);
    expect(latest?.decision).toBe("accept");

    // UNIQUE(negotiation_id, round_number)
    await expect(
      rounds.create({
        id: negotiationRoundId(),
        negotiation_id: neg.id,
        round_number: 1,
        from_agent_id: initiatorAgent,
        decision: "propose",
        message: "duplicate",
      }),
    ).rejects.toThrow();
  });

  it("rounds cascade on negotiation delete", async () => {
    const neg = await negotiations.create({
      id: negotiationId(),
      initiator_agent_id: initiatorAgent,
      initiator_session_id: initiatorSession,
      counterparty_agent_id: counterpartyAgent,
      max_rounds: 5,
    });
    await rounds.create({
      id: negotiationRoundId(),
      negotiation_id: neg.id,
      round_number: 1,
      from_agent_id: initiatorAgent,
      decision: "propose",
      message: "v1",
    });
    expect((await rounds.listByNegotiation(neg.id)).length).toBe(1);
    await pool.query(`DELETE FROM negotiation WHERE id = $1`, [neg.id]);
    expect(await rounds.listByNegotiation(neg.id)).toEqual([]);
  });
});
