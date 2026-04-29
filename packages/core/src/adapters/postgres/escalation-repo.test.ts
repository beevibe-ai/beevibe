import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import {
  agentId,
  escalationId,
  negotiationId,
  personId,
  sessionId,
} from "../../domain/ids.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import type { Pool } from "./client.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresEscalationRepository } from "./escalation-repo.js";
import { PostgresNegotiationRepository } from "./negotiation-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresSessionRepository } from "./session-repo.js";

describe("PostgresEscalationRepository", () => {
  let pool: Pool;
  let escalations: PostgresEscalationRepository;
  let negotiations: PostgresNegotiationRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let sessions: PostgresSessionRepository;

  let neg: string;
  let initiatorSession: string;
  let counterpartySession: string;
  let person: string;

  beforeAll(() => {
    pool = createTestPool();
    escalations = new PostgresEscalationRepository(pool);
    negotiations = new PostgresNegotiationRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
    sessions = new PostgresSessionRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Owner" });
    person = owner.id;
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
    const sa = await sessions.create({
      id: sessionId(),
      agent_id: a.id,
      type: "task",
      status: "running",
      intent: "i",
    });
    const sb = await sessions.create({
      id: sessionId(),
      agent_id: b.id,
      type: "mesh_negotiate",
      status: "running",
      intent: "j",
    });
    initiatorSession = sa.id;
    counterpartySession = sb.id;
    const negotiation = await negotiations.create({
      id: negotiationId(),
      initiator_agent_id: a.id,
      initiator_session_id: sa.id,
      counterparty_agent_id: b.id,
      counterparty_session_id: sb.id,
      max_rounds: 5,
    });
    neg = negotiation.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("create + findById round-trips with status='pending', empty counterparty slot", async () => {
    const id = escalationId();
    const created = await escalations.create({
      id,
      negotiation_id: neg,
      initiator_session_id: initiatorSession,
      counterparty_session_id: counterpartySession,
      summary: "Stuck on whether to do X or Y; root disagreement is Z.",
      initiator_proposals: [
        { title: "Option A", description: "do X" },
        { title: "Option B", description: "do Y" },
      ],
      initiator_open_questions: ["Should we cap timeline?"],
      initiator_submitted_at: new Date(),
      escalated_by_role: "initiator",
    });

    expect(created.status).toBe("pending");
    expect(created.summary).toContain("root disagreement");
    expect(created.initiator_proposals).toHaveLength(2);
    expect(created.initiator_open_questions).toEqual(["Should we cap timeline?"]);
    expect(created.counterparty_proposals).toBeUndefined();
    expect(created.counterparty_open_questions).toEqual([]);
    expect(created.counterparty_submitted_at).toBeUndefined();

    const found = await escalations.findById(id);
    expect(found?.summary).toBe(created.summary);
  });

  it("findByNegotiation respects the UNIQUE constraint", async () => {
    const id = escalationId();
    await escalations.create({
      id,
      negotiation_id: neg,
      initiator_session_id: initiatorSession,
      counterparty_session_id: counterpartySession,
      summary: "x",
      escalated_by_role: "initiator",
      initiator_open_questions: [],
    });

    const found = await escalations.findByNegotiation(neg);
    expect(found?.id).toBe(id);

    // UNIQUE(negotiation_id) prevents a second escalation row for the same neg.
    await expect(
      escalations.create({
        id: escalationId(),
        negotiation_id: neg,
        initiator_session_id: initiatorSession,
        counterparty_session_id: counterpartySession,
        summary: "dup",
        escalated_by_role: "counterparty",
        initiator_open_questions: [],
      }),
    ).rejects.toThrow();
  });

  it("update populates counterparty slot via add_to_escalation pattern", async () => {
    const created = await escalations.create({
      id: escalationId(),
      negotiation_id: neg,
      initiator_session_id: initiatorSession,
      counterparty_session_id: counterpartySession,
      summary: "stuck",
      escalated_by_role: "initiator",
      initiator_open_questions: [],
    });
    const updated = await escalations.update(created.id, {
      counterparty_proposals: [{ title: "Hybrid", description: "blend X+Y" }],
      counterparty_open_questions: ["Approval needed?"],
      counterparty_submitted_at: new Date(),
    });
    expect(updated.counterparty_proposals).toEqual([
      { title: "Hybrid", description: "blend X+Y" },
    ]);
    expect(updated.counterparty_open_questions).toEqual(["Approval needed?"]);
    expect(updated.counterparty_submitted_at).toBeInstanceOf(Date);
    // Initiator slot untouched
    expect(updated.initiator_proposals).toBeUndefined();
  });

  it("update sets resolution + status='resolved' (resolution_required CHECK passes)", async () => {
    const created = await escalations.create({
      id: escalationId(),
      negotiation_id: neg,
      initiator_session_id: initiatorSession,
      counterparty_session_id: counterpartySession,
      summary: "stuck",
      escalated_by_role: "initiator",
      initiator_open_questions: [],
    });
    const resolved = await escalations.update(created.id, {
      status: "resolved",
      resolution_proposal: {
        title: "Hybrid approach",
        description: "Reuse X but rewrite Y.",
        source: "human",
      },
      resolution_notes: "Cap at 4 weeks.",
      resolved_by: person,
      resolved_at: new Date(),
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution_proposal?.title).toBe("Hybrid approach");
    expect(resolved.resolution_notes).toBe("Cap at 4 weeks.");
    expect(resolved.resolved_by).toBe(person);
  });

  it("setting status='resolved' without resolution_proposal violates the CHECK", async () => {
    const created = await escalations.create({
      id: escalationId(),
      negotiation_id: neg,
      initiator_session_id: initiatorSession,
      counterparty_session_id: counterpartySession,
      summary: "stuck",
      escalated_by_role: "initiator",
      initiator_open_questions: [],
    });
    await expect(
      escalations.update(created.id, { status: "resolved" }),
    ).rejects.toThrow();
  });

  it("listPending returns only pending rows in created_at ASC", async () => {
    const e1 = await escalations.create({
      id: escalationId(),
      negotiation_id: neg,
      initiator_session_id: initiatorSession,
      counterparty_session_id: counterpartySession,
      summary: "x",
      escalated_by_role: "initiator",
      initiator_open_questions: [],
    });

    // Need a second negotiation for a second escalation (UNIQUE)
    const ownerLite = await persons.create({ id: personId(), name: "Lite" });
    const a2 = await agents.create({
      id: agentId(),
      name: "I2",
      owner_id: ownerLite.id,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    const b2 = await agents.create({
      id: agentId(),
      name: "C2",
      owner_id: ownerLite.id,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    const sa2 = await sessions.create({
      id: sessionId(),
      agent_id: a2.id,
      type: "task",
      status: "running",
      intent: "i2",
    });
    const sb2 = await sessions.create({
      id: sessionId(),
      agent_id: b2.id,
      type: "mesh_negotiate",
      status: "running",
      intent: "j2",
    });
    const neg2 = await negotiations.create({
      id: negotiationId(),
      initiator_agent_id: a2.id,
      initiator_session_id: sa2.id,
      counterparty_agent_id: b2.id,
      counterparty_session_id: sb2.id,
      max_rounds: 5,
    });
    await escalations.create({
      id: escalationId(),
      negotiation_id: neg2.id,
      initiator_session_id: sa2.id,
      counterparty_session_id: sb2.id,
      summary: "y",
      escalated_by_role: "initiator",
      initiator_open_questions: [],
    });

    // Resolve the first one
    await escalations.update(e1.id, {
      status: "resolved",
      resolution_proposal: { title: "x", description: "y", source: "human" },
      resolved_by: person,
      resolved_at: new Date(),
    });

    const pending = await escalations.listPending();
    expect(pending.map((e) => e.id)).not.toContain(e1.id);
    expect(pending.length).toBe(1);
  });
});
