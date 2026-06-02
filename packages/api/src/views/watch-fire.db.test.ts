/**
 * Real-Postgres tests for the `trg_task_watch_check` trigger. Drives
 * task.status transitions and asserts that matching task_watch rows
 * fire (insert a new wake session + flip to status='fired') under the
 * mode='all' / mode='any' contract.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresPersonRepository,
  PostgresSessionRepository,
  PostgresTaskRepository,
  PostgresTaskWatchRepository,
  type Pool,
} from "@beevibe/core/adapters/postgres";
import { provisionAgent, provisionUser } from "@beevibe/core/auth";
import {
  DEFAULT_RUNTIME_CONFIG,
  agentId,
  personId,
  sessionId,
  taskId,
  taskWatchId,
} from "@beevibe/core";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";

describe("trg_task_watch_check — integration", () => {
  let pool: Pool;
  let watches: PostgresTaskWatchRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let coreMemories: PostgresCoreMemoryRepository;
  let sessions: PostgresSessionRepository;
  let tasks: PostgresTaskRepository;

  let waiterSessionId: string;
  let teamAgentId: string;
  let icAgentId: string;

  beforeAll(() => {
    pool = createTestPool();
    watches = new PostgresTaskWatchRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
    coreMemories = new PostgresCoreMemoryRepository(pool);
    sessions = new PostgresSessionRepository(pool);
    tasks = new PostgresTaskRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);

    const owner = await provisionUser(
      { personRepo: persons },
      { id: personId(), name: "Owner", email: `owner-${Date.now()}@example.com` },
    );
    const team = await provisionAgent(
      { agentRepo: agents, coreMemoryRepo: coreMemories },
      {
        id: agentId(),
        name: "Team",
        owner_id: owner.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    const ic = await provisionAgent(
      { agentRepo: agents, coreMemoryRepo: coreMemories },
      {
        id: agentId(),
        name: "IC",
        owner_id: owner.person.id,
        hierarchy_level: "ic",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
        parent_agent_id: team.agent.id,
      },
    );
    const waiter = await sessions.create({
      id: sessionId(),
      agent_id: team.agent.id,
      type: "chat",
      status: "succeeded",
      intent: "watch test",
    });
    waiterSessionId = waiter.id;
    teamAgentId = team.agent.id;
    icAgentId = ic.agent.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createTask(title: string): Promise<string> {
    const t = await tasks.create({
      id: taskId(),
      title,
      description: title.toLowerCase(),
      priority: "medium",
      assignee_id: icAgentId,
      creator_id: teamAgentId,
      creator_type: "agent",
      status: "in_progress",
    });
    return t.id;
  }

  async function createWatch(
    taskIds: string[],
    mode: "all" | "any",
  ): Promise<string> {
    const w = await watches.create({
      id: taskWatchId(),
      waiter_session_id: waiterSessionId,
      agent_id: teamAgentId,
      mode,
      task_ids: taskIds,
    });
    return w.id;
  }

  async function findWakeSession(watchId: string) {
    const watch = await watches.findById(watchId);
    if (!watch?.fired_session_id) return undefined;
    return sessions.findById(watch.fired_session_id);
  }

  it("mode='all': first task done -> no fire; second done -> fire", async () => {
    const a = await createTask("Backend");
    const b = await createTask("Frontend");
    const w = await createWatch([a, b], "all");

    await tasks.updateProgress(a, "done", "shipped a");
    const afterFirst = await watches.findById(w);
    expect(afterFirst?.status).toBe("waiting");

    await tasks.updateProgress(b, "done", "shipped b");
    const afterSecond = await watches.findById(w);
    expect(afterSecond?.status).toBe("fired");
    expect(afterSecond?.fired_session_id).toBeDefined();

    const wake = await findWakeSession(w);
    expect(wake?.agent_id).toBe(teamAgentId);
    expect(wake?.prior_session_id).toBe(waiterSessionId);
    expect(wake?.type).toBe("chat");
    expect(wake?.status).toBe("pending");
    expect(wake?.intent).toContain("2 tasks completed:");
    expect(wake?.intent).toContain("Backend — done. Result: shipped a");
    expect(wake?.intent).toContain("Frontend — done. Result: shipped b");
    expect(wake?.intent).toContain("Decide next steps.");
  });

  it("mode='any': first done -> fire; second done does not re-fire", async () => {
    const a = await createTask("Backend");
    const b = await createTask("Frontend");
    const w = await createWatch([a, b], "any");

    await tasks.updateProgress(a, "done", "shipped a");
    const afterFirst = await watches.findById(w);
    expect(afterFirst?.status).toBe("fired");
    const firstFiredSession = afterFirst?.fired_session_id;
    expect(firstFiredSession).toBeDefined();

    await tasks.updateProgress(b, "done", "shipped b");
    const afterSecond = await watches.findById(w);
    expect(afterSecond?.fired_session_id).toBe(firstFiredSession);

    const wake = await findWakeSession(w);
    expect(wake?.intent).toContain("Task Backend — done. Result: shipped a");
    expect(wake?.intent).toContain("Other watched tasks still running:");
    expect(wake?.intent).toContain("Frontend — in_progress");
  });

  it("watch.reason is surfaced as a 'Wake reason:' prefix in the intent", async () => {
    const a = await createTask("Backend");
    const w = await watches.create({
      id: taskWatchId(),
      waiter_session_id: waiterSessionId,
      agent_id: teamAgentId,
      mode: "all",
      task_ids: [a],
      reason: "checking deploy progress",
    });

    await tasks.updateProgress(a, "done", "shipped");
    const fired = await watches.findById(w.id);
    const wake = await sessions.findById(fired!.fired_session_id!);
    expect(wake?.intent).toContain("Wake reason: checking deploy progress");
    expect(wake?.intent).toContain("Backend — done. Result: shipped");
  });

  it("wraps the wake intent in <system-wake> so chainToMessages can skip the user bubble", async () => {
    const a = await createTask("Backend");
    const w = await createWatch([a], "all");
    await tasks.updateProgress(a, "done", "shipped");
    const wake = await findWakeSession(w);
    expect(wake?.intent.startsWith("<system-wake>")).toBe(true);
    expect(wake?.intent.endsWith("</system-wake>")).toBe(true);
  });

  it("inherits waiter.runtime_id on the wake session (runtime-pinning)", async () => {
    // Seed a daemon + runtime + a chat waiter pinned to that runtime;
    // the wake session must inherit the same runtime_id so the user's
    // daemon claims it instead of the server-fallback worker.
    const suffix = Date.now();
    const ownerRow = await pool.query<{ owner_id: string }>(
      `SELECT owner_id FROM agent WHERE id = $1`,
      [teamAgentId],
    );
    const personId_ = ownerRow.rows[0]!.owner_id;
    const daemonId = `dmn_pin_${suffix}`;
    const rt = `rt_pin_${suffix}`;
    await pool.query(
      `INSERT INTO daemon (id, owner_person_id, external_id, device_name, token_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [daemonId, personId_, `ext_${suffix}`, `dev_${suffix}`, `hash_${suffix}`],
    );
    await pool.query(
      `INSERT INTO runtime (id, daemon_id, cli, capabilities)
       VALUES ($1, $2, 'claude', '{}'::jsonb)`,
      [rt, daemonId],
    );
    const pinnedWaiter = await sessions.create({
      id: sessionId(),
      agent_id: teamAgentId,
      type: "chat",
      status: "succeeded",
      intent: "pinned",
      runtime_id: rt,
    });
    const a = await createTask("Backend");
    // Reparent the task's IC session under the pinned waiter (the auth
    // check on the watch is satisfied by parent_session_id ∈ chain).
    await pool.query(
      `UPDATE session SET parent_session_id = $1 WHERE task_id = $2 AND parent_session_id IS NOT NULL`,
      [pinnedWaiter.id, a],
    );
    const w = await watches.create({
      id: taskWatchId(),
      waiter_session_id: pinnedWaiter.id,
      agent_id: teamAgentId,
      mode: "all",
      task_ids: [a],
    });

    await tasks.updateProgress(a, "done", "shipped");
    const wake = await sessions.findById(
      (await watches.findById(w.id))!.fired_session_id!,
    );
    expect(wake?.runtime_id).toBe(rt);
  });

  it("mode='any' with one task: no 'others still running' block", async () => {
    const a = await createTask("Solo");
    const w = await createWatch([a], "any");

    await tasks.updateProgress(a, "done", "shipped");
    const wake = await findWakeSession(w);
    expect(wake?.intent).toContain("Task Solo — done. Result: shipped");
    expect(wake?.intent).not.toContain("Other watched tasks still running:");
    expect(wake?.intent).toContain("Decide next steps.");
  });

  it("failed terminal status fires the watch", async () => {
    const a = await createTask("Backend");
    const w = await createWatch([a], "all");

    await tasks.updateProgress(a, "failed", "auth tokens broke");
    const fired = await watches.findById(w);
    expect(fired?.status).toBe("fired");
    const wake = await findWakeSession(w);
    expect(wake?.intent).toContain("Backend — failed: auth tokens broke");
  });

  it("cancelled terminal status fires the watch", async () => {
    const a = await createTask("Backend");
    const w = await createWatch([a], "all");

    await tasks.update(a, { status: "cancelled" });
    const fired = await watches.findById(w);
    expect(fired?.status).toBe("fired");
    const wake = await findWakeSession(w);
    expect(wake?.intent).toContain("Backend — cancelled");
    expect(wake?.intent).not.toContain("Result:");
  });

  it("blocked -> done sequence: only the done transition fires", async () => {
    const a = await createTask("Backend");
    const w = await createWatch([a], "all");

    await tasks.markBlocked(a, icAgentId, "needs credentials");
    expect((await watches.findById(w))?.status).toBe("waiting");

    await tasks.updateProgress(a, "done", "credentials provisioned");
    expect((await watches.findById(w))?.status).toBe("fired");
  });

  it("needs_revision -> in_progress -> done: only the done transition fires", async () => {
    const a = await createTask("Backend");
    const w = await createWatch([a], "all");

    await tasks.update(a, { status: "needs_revision" });
    await tasks.update(a, { status: "in_progress" });
    expect((await watches.findById(w))?.status).toBe("waiting");

    await tasks.updateProgress(a, "done", "fixed");
    expect((await watches.findById(w))?.status).toBe("fired");
  });

  it("in_progress -> in_progress (no status change) does not fire", async () => {
    const a = await createTask("Backend");
    const w = await createWatch([a], "all");

    await tasks.update(a, { status: "in_progress" });
    expect((await watches.findById(w))?.status).toBe("waiting");
  });

  it("aborted watch is not fired by a subsequent terminal transition", async () => {
    const a = await createTask("Backend");
    const w = await createWatch([a], "all");

    await watches.markAborted(w);
    await tasks.updateProgress(a, "done", "shipped");
    const final = await watches.findById(w);
    expect(final?.status).toBe("aborted");
    expect(final?.fired_session_id).toBeUndefined();
  });

  it("wake inherits waiter's task_id when set (task-session continuation)", async () => {
    // A team agent in a task session that dispatches sub-tasks. Its
    // wake should continue the same task lineage.
    const parentTask = await createTask("Parent");
    const taskWaiter = await sessions.create({
      id: sessionId(),
      agent_id: teamAgentId,
      type: "task",
      status: "succeeded",
      intent: "running parent task",
      task_id: parentTask,
    });
    const child = await createTask("Child");
    const w = await watches.create({
      id: taskWatchId(),
      waiter_session_id: taskWaiter.id,
      agent_id: teamAgentId,
      mode: "all",
      task_ids: [child],
    });

    await tasks.updateProgress(child, "done", "ok");
    const fired = await watches.findById(w.id);
    expect(fired?.status).toBe("fired");
    const wake = await sessions.findById(fired!.fired_session_id!);
    expect(wake?.task_id).toBe(parentTask);
    expect(wake?.type).toBe("task");
    expect(wake?.conversation_id).toBeUndefined();
  });
});
