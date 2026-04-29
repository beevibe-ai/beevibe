/**
 * POST /escalation/:id/resolve integration tests. Real Postgres + real
 * negotiation + escalation rows. Verifies:
 *
 *   - source='human' / 'initiator' / 'counterparty' selectors
 *   - resolution_proposal stamped correctly + edits preserved
 *   - escalation transitions pending → resolved
 *   - initiator's task gets next_dispatch_context (re-queued for executor)
 *   - counterparty synthetic task is created with the same context
 *   - pg_notify('escalation_resolved', id) fires
 *   - 403 / 401 / 404 / 409 / 400 surfaces
 */
import express, { json } from "express";
import request from "supertest";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresEscalationRepository,
  PostgresNegotiationRepository,
  PostgresPersonRepository,
  PostgresSessionRepository,
  PostgresTaskRepository,
  PostgresWorkProductRepository,
  type Pool,
} from "@beevibe/core/adapters/postgres";
import { provisionAgent, provisionUser } from "@beevibe/core/auth";
import { EscalationService } from "@beevibe/core/services/escalation-service";
import {
  DEFAULT_RUNTIME_CONFIG,
  agentId,
  escalationId,
  negotiationId,
  personId,
  sessionId,
  taskId,
} from "@beevibe/core";
import type { Escalation, Negotiation, Task } from "@beevibe/core";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createEscalationRouter } from "./escalation.js";

describe("escalation routes — integration", () => {
  let pool: Pool;
  let agentRepo: PostgresAgentRepository;
  let personRepo: PostgresPersonRepository;
  let coreMemoryRepo: PostgresCoreMemoryRepository;
  let sessionRepo: PostgresSessionRepository;
  let taskRepo: PostgresTaskRepository;
  let workProductRepo: PostgresWorkProductRepository;
  let negotiationRepo: PostgresNegotiationRepository;
  let escalationRepo: PostgresEscalationRepository;
  let escalationService: EscalationService;

  beforeAll(() => {
    pool = createTestPool();
    agentRepo = new PostgresAgentRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
    coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
    sessionRepo = new PostgresSessionRepository(pool);
    taskRepo = new PostgresTaskRepository(pool);
    workProductRepo = new PostgresWorkProductRepository(pool);
    negotiationRepo = new PostgresNegotiationRepository(pool);
    escalationRepo = new PostgresEscalationRepository(pool);
    escalationService = new EscalationService({
      escalationRepo,
      negotiationRepo,
      taskRepo,
      agentRepo,
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
      "/escalation",
      createEscalationRouter({
        authMiddleware: createAuthMiddleware({ agentRepo, personRepo }),
        escalationService,
        pool,
      }),
    );
    return app;
  }

  /**
   * Seeds: persons, agents, sessions, the original task A was working on,
   * a negotiation with both sides' sessions, and an escalation row with
   * BOTH sides having submitted proposals.
   */
  async function seedEscalation(): Promise<{
    humanApiKey: string;
    personId: string;
    initiator: { id: string; sessionId: string };
    counterparty: { id: string; sessionId: string };
    task: Task;
    negotiation: Negotiation;
    escalation: Escalation;
  }> {
    const owner = await provisionUser(
      { personRepo },
      { id: personId(), name: "Owner", email: "owner@example.com" },
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

    const task = await taskRepo.create({
      id: taskId(),
      title: "Build feature X",
      status: "blocked",
      priority: "medium",
      assignee_id: teamA.agent.id,
      creator_id: owner.person.id,
      creator_type: "person",
    });

    const negotiation = await negotiationRepo.create({
      id: negotiationId(),
      initiator_agent_id: teamA.agent.id,
      initiator_session_id: sa.id,
      counterparty_agent_id: teamB.agent.id,
      counterparty_session_id: sb.id,
      task_id: task.id,
      max_rounds: 3,
    });
    await negotiationRepo.update(negotiation.id, { status: "escalated" });

    const escalation = await escalationRepo.create({
      id: escalationId(),
      negotiation_id: negotiation.id,
      initiator_session_id: sa.id,
      counterparty_session_id: sb.id,
      summary: "Stuck on rewrite vs refactor; root disagreement is timeline.",
      initiator_proposals: [
        { title: "Rewrite in React", description: "Big-bang rewrite over Q3." },
        { title: "Migrate gradually", description: "Component-by-component over 2 quarters." },
      ],
      initiator_open_questions: ["Is the timeline flexible?"],
      initiator_submitted_at: new Date(),
      escalated_by_role: "initiator",
    });
    await escalationRepo.update(escalation.id, {
      counterparty_proposals: [
        { title: "Refactor backend first", description: "Backend isn't ready; do that for 2 sprints." },
        { title: "SSR for new pages only", description: "Hybrid: keep old pages, SSR new ones." },
      ],
      counterparty_open_questions: ["Who owns backend bandwidth?"],
      counterparty_submitted_at: new Date(),
    });
    const finalEsc = await escalationRepo.findById(escalation.id);
    if (!finalEsc) throw new Error("seed escalation lost");

    return {
      humanApiKey: owner.apiKey,
      personId: owner.person.id,
      initiator: { id: teamA.agent.id, sessionId: sa.id },
      counterparty: { id: teamB.agent.id, sessionId: sb.id },
      task,
      negotiation,
      escalation: finalEsc,
    };
  }

  it("source='counterparty' resolution: chosen proposal copied + status=resolved", async () => {
    const seed = await seedEscalation();

    const res = await request(makeApp())
      .post(`/escalation/${seed.escalation.id}/resolve`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`)
      .send({
        source: "counterparty",
        source_index: 0,
        resolution_notes: "Cap timeline at 4 weeks.",
      });

    expect(res.status).toBe(200);
    expect(res.body.escalation.status).toBe("resolved");
    expect(res.body.escalation.resolution_proposal).toMatchObject({
      title: "Refactor backend first",
      source: "counterparty",
      source_index: 0,
    });
    expect(res.body.escalation.resolution_notes).toBe("Cap timeline at 4 weeks.");
    expect(res.body.a_task_id).toBe(seed.task.id);
    expect(res.body.b_task_id).toMatch(/^task_/);
    expect(res.body.b_task_id).not.toBe(seed.task.id);
  });

  it("re-queues initiator's task with post_escalation context", async () => {
    const seed = await seedEscalation();

    await request(makeApp())
      .post(`/escalation/${seed.escalation.id}/resolve`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`)
      .send({ source: "initiator", source_index: 1 });

    const refetched = await taskRepo.findById(seed.task.id);
    expect(refetched?.status).toBe("assigned");
    expect(refetched?.next_dispatch_context).toMatchObject({
      kind: "post_escalation",
      role: "initiator",
      prior_session_id: seed.initiator.sessionId,
    });
    if (refetched?.next_dispatch_context?.kind === "post_escalation") {
      expect(refetched.next_dispatch_context.resolution.title).toBe("Migrate gradually");
    }
  });

  it("creates synthetic task for counterparty with role='counterparty' context", async () => {
    const seed = await seedEscalation();

    const res = await request(makeApp())
      .post(`/escalation/${seed.escalation.id}/resolve`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`)
      .send({ source: "human", title: "Hybrid X", description: "Reuse + rewrite Y." });

    const synthTaskId = res.body.b_task_id;
    const synth = await taskRepo.findById(synthTaskId);
    expect(synth?.assignee_id).toBe(seed.counterparty.id);
    expect(synth?.creator_type).toBe("person");
    expect(synth?.creator_id).toBe(seed.personId);
    expect(synth?.parent_task_id).toBe(seed.task.id);
    expect(synth?.status).toBe("assigned");
    expect(synth?.next_dispatch_context).toMatchObject({
      kind: "post_escalation",
      role: "counterparty",
      prior_session_id: seed.counterparty.sessionId,
    });
    if (synth?.next_dispatch_context?.kind === "post_escalation") {
      expect(synth.next_dispatch_context.resolution.title).toBe("Hybrid X");
      expect(synth.next_dispatch_context.resolution.source).toBe("human");
    }
  });

  it("source='counterparty' with edited_title overrides original; source_index preserved for audit", async () => {
    const seed = await seedEscalation();

    const res = await request(makeApp())
      .post(`/escalation/${seed.escalation.id}/resolve`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`)
      .send({
        source: "counterparty",
        source_index: 1,
        edited_title: "SSR pilot for the homepage only",
      });

    expect(res.body.escalation.resolution_proposal).toMatchObject({
      title: "SSR pilot for the homepage only",
      description: "Hybrid: keep old pages, SSR new ones.",
      source: "counterparty",
      source_index: 1,
    });
  });

  it("pg_notify('escalation_resolved', id) fires on resolve", async () => {
    const seed = await seedEscalation();

    const listener = new PgClient({ connectionString: process.env.DATABASE_URL_TEST });
    await listener.connect();
    const notifications: string[] = [];
    listener.on("notification", (msg) => {
      if (msg.channel === "escalation_resolved" && msg.payload) {
        notifications.push(msg.payload);
      }
    });
    await listener.query("LISTEN escalation_resolved");

    try {
      await request(makeApp())
        .post(`/escalation/${seed.escalation.id}/resolve`)
        .set("Authorization", `Bearer ${seed.humanApiKey}`)
        .send({ source: "human", title: "x", description: "y" });

      // Wait briefly for the round-trip
      await new Promise((r) => setTimeout(r, 100));
      expect(notifications).toContain(seed.escalation.id);
    } finally {
      await listener.end();
    }
  });

  it("404 when escalation not found", async () => {
    const seed = await seedEscalation();

    const res = await request(makeApp())
      .post(`/escalation/esc_nonexistent/resolve`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`)
      .send({ source: "human", title: "x", description: "y" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("escalation_not_found");
  });

  it("409 when escalation already resolved", async () => {
    const seed = await seedEscalation();
    // Resolve once
    await request(makeApp())
      .post(`/escalation/${seed.escalation.id}/resolve`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`)
      .send({ source: "human", title: "x", description: "y" });
    // Resolve again — should 409
    const res = await request(makeApp())
      .post(`/escalation/${seed.escalation.id}/resolve`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`)
      .send({ source: "human", title: "x2", description: "y2" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_state");
  });

  it("400 when source is invalid", async () => {
    const seed = await seedEscalation();
    const res = await request(makeApp())
      .post(`/escalation/${seed.escalation.id}/resolve`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`)
      .send({ source: "rumor" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_source");
  });

  it("400 when source='human' missing title/description", async () => {
    const seed = await seedEscalation();
    const res = await request(makeApp())
      .post(`/escalation/${seed.escalation.id}/resolve`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`)
      .send({ source: "human", title: "only title" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_human_resolution");
  });

  it("400 when source='counterparty' missing source_index", async () => {
    const seed = await seedEscalation();
    const res = await request(makeApp())
      .post(`/escalation/${seed.escalation.id}/resolve`)
      .set("Authorization", `Bearer ${seed.humanApiKey}`)
      .send({ source: "counterparty" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_source_index");
  });

  it("agent caller (bv_a_) → 403", async () => {
    const seed = await seedEscalation();
    const owner = await personRepo.findByApiKey(seed.humanApiKey);
    expect(owner).toBeDefined();

    // Provision a separate agent with bv_a_ key for this auth check.
    const otherTeam = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Some Other Team",
        owner_id: owner!.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );

    const res = await request(makeApp())
      .post(`/escalation/${seed.escalation.id}/resolve`)
      .set("Authorization", `Bearer ${otherTeam.apiKey}`)
      .send({ source: "human", title: "x", description: "y" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("missing token → 401", async () => {
    const res = await request(makeApp()).post("/escalation/esc_x/resolve");
    expect(res.status).toBe(401);
  });
});
