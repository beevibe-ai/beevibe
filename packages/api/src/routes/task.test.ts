/**
 * Human REST routes for task review (M6.4). Spins up just the task router
 * (no MCP, no mesh) against a real Postgres + provisioned humans/agents to
 * exercise the end-to-end auth → service → DB → pg_notify wiring.
 */
import express, { json } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresPersonRepository,
  PostgresSessionRepository,
  PostgresTaskRepository,
  PostgresWorkProductRepository,
  type Pool,
} from "@beevibe/core/adapters/postgres";
import { provisionAgent, provisionUser } from "@beevibe/core/auth";
import { TaskService } from "@beevibe/core/services/task-service";
import { DEFAULT_RUNTIME_CONFIG, agentId, personId, taskId } from "@beevibe/core";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import { createAuthMiddleware } from "../auth/middleware.js";
import { createTaskRouter } from "./task.js";

describe("task routes — integration", () => {
  let pool: Pool;
  let agentRepo: PostgresAgentRepository;
  let personRepo: PostgresPersonRepository;
  let coreMemoryRepo: PostgresCoreMemoryRepository;
  let sessionRepo: PostgresSessionRepository;
  let taskRepo: PostgresTaskRepository;
  let workProductRepo: PostgresWorkProductRepository;
  let taskService: TaskService;

  beforeAll(() => {
    pool = createTestPool();
    agentRepo = new PostgresAgentRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
    coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
    sessionRepo = new PostgresSessionRepository(pool);
    taskRepo = new PostgresTaskRepository(pool);
    workProductRepo = new PostgresWorkProductRepository(pool);
    taskService = new TaskService({ taskRepo, workProductRepo, agentRepo, sessionRepo });
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
      "/task",
      createTaskRouter({
        authMiddleware: createAuthMiddleware({ agentRepo, personRepo }),
        taskRepo,
        taskService,
        pool,
      }),
    );
    return app;
  }

  async function setupHuman() {
    const owner = await provisionUser(
      { personRepo },
      { id: personId(), name: "Alice", email: "alice@example.com" },
    );
    const agent = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Alice's Agent",
        owner_id: owner.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    return { owner, agent };
  }

  async function seedTask(status: "review" | "blocked" | "in_progress", assigneeId: string) {
    return taskRepo.create({
      id: taskId(),
      title: "test task",
      status,
      priority: "medium",
      assignee_id: assigneeId,
      creator_id: assigneeId,
      creator_type: "agent",
    });
  }

  it("approve: review → done with summary", async () => {
    const { owner, agent } = await setupHuman();
    const task = await seedTask("review", agent.agent.id);

    const res = await request(makeApp())
      .post(`/task/${task.id}/approve`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ result_summary: "looks good" });

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe("done");
    const refetched = await taskRepo.findById(task.id);
    expect(refetched?.status).toBe("done");
    expect(refetched?.result_summary).toBe("looks good");
  });

  it("reject: blocked → cancelled", async () => {
    const { owner, agent } = await setupHuman();
    const task = await seedTask("blocked", agent.agent.id);

    const res = await request(makeApp())
      .post(`/task/${task.id}/reject`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ result_summary: "not pursuing" });

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe("cancelled");
  });

  it("revise: review → needs_revision + stamps next_dispatch_context", async () => {
    const { owner, agent } = await setupHuman();
    const task = await seedTask("review", agent.agent.id);

    const res = await request(makeApp())
      .post(`/task/${task.id}/revise`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ feedback: "please add error handling" });

    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe("needs_revision");

    const refetched = await taskRepo.findById(task.id);
    expect(refetched?.status).toBe("needs_revision");
    expect(refetched?.next_dispatch_context?.kind).toBe("revision");
    if (refetched?.next_dispatch_context?.kind === "revision") {
      expect(refetched.next_dispatch_context.feedback).toBe("please add error handling");
      expect(refetched.next_dispatch_context.source).toBe("human");
      expect(refetched.next_dispatch_context.from_status).toBe("review");
    }
  });

  it("revise: missing feedback → 400", async () => {
    const { owner, agent } = await setupHuman();
    const task = await seedTask("review", agent.agent.id);

    const res = await request(makeApp())
      .post(`/task/${task.id}/revise`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("feedback_required");
  });

  it("revise from invalid status → 409", async () => {
    const { owner, agent } = await setupHuman();
    const task = await seedTask("in_progress", agent.agent.id);

    const res = await request(makeApp())
      .post(`/task/${task.id}/revise`)
      .set("Authorization", `Bearer ${owner.apiKey}`)
      .send({ feedback: "x" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_transition");
  });

  it("cancel: in_progress → cancelled + pg_notify fires", async () => {
    const { owner, agent } = await setupHuman();
    const task = await seedTask("in_progress", agent.agent.id);

    // Listen to cancel_task on a separate connection so we can verify the
    // notify lands. Real connection (not pool) — pg_notify needs a holding
    // session.
    const { Client: PgClient } = await import("pg");
    const listener = new PgClient({ connectionString: process.env.DATABASE_URL_TEST });
    await listener.connect();
    const notifications: Array<{ channel: string; payload?: string }> = [];
    listener.on("notification", (msg) => {
      notifications.push({ channel: msg.channel, payload: msg.payload });
    });
    await listener.query("LISTEN cancel_task");

    try {
      const res = await request(makeApp())
        .post(`/task/${task.id}/cancel`)
        .set("Authorization", `Bearer ${owner.apiKey}`)
        .send({ reason: "scope drift" });

      expect(res.status).toBe(200);

      const refetched = await taskRepo.findById(task.id);
      expect(refetched?.status).toBe("cancelled");
      expect(refetched?.result_summary).toContain("cancelled by");
      expect(refetched?.result_summary).toContain("scope drift");

      // Wait briefly for the LISTEN/NOTIFY round-trip
      await new Promise((r) => setTimeout(r, 100));
      const cancelNote = notifications.find((n) => n.channel === "cancel_task");
      expect(cancelNote?.payload).toBe(task.id);
    } finally {
      await listener.end();
    }
  });

  it("cancel from terminal status → 409", async () => {
    const { owner, agent } = await setupHuman();
    const task = await taskRepo.create({
      id: taskId(),
      title: "done task",
      status: "done",
      priority: "medium",
      assignee_id: agent.agent.id,
      creator_id: agent.agent.id,
      creator_type: "agent",
    });

    const res = await request(makeApp())
      .post(`/task/${task.id}/cancel`)
      .set("Authorization", `Bearer ${owner.apiKey}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_transition");
  });

  it("agent caller (bv_a_) → 403", async () => {
    const { agent } = await setupHuman();
    const task = await seedTask("review", agent.agent.id);

    const res = await request(makeApp())
      .post(`/task/${task.id}/approve`)
      .set("Authorization", `Bearer ${agent.apiKey}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("missing token → 401", async () => {
    const res = await request(makeApp()).post("/task/task_x/approve");
    expect(res.status).toBe(401);
  });
});
