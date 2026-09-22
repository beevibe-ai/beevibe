import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import {
  agentId,
  personId,
  sessionId,
  taskId,
  taskWatchId,
} from "../../domain/ids.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import type { Pool } from "./client.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresSessionRepository } from "./session-repo.js";
import { PostgresTaskRepository } from "./task-repo.js";
import { PostgresTaskWatchRepository } from "./task-watch-repo.js";

describe("PostgresTaskWatchRepository", () => {
  let pool: Pool;
  let watches: PostgresTaskWatchRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let sessions: PostgresSessionRepository;
  let tasks: PostgresTaskRepository;

  let waiterSession: string;
  let agentIdValue: string;
  let taskA: string;
  let taskB: string;

  beforeAll(() => {
    pool = createTestPool();
    watches = new PostgresTaskWatchRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
    sessions = new PostgresSessionRepository(pool);
    tasks = new PostgresTaskRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Owner" });
    const team = await agents.create({
      id: agentId(),
      name: "Team",
      owner_id: owner.id,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    const ic = await agents.create({
      id: agentId(),
      name: "IC",
      owner_id: owner.id,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
      parent_agent_id: team.id,
    });
    const waiter = await sessions.create({
      id: sessionId(),
      agent_id: team.id,
      type: "chat",
      status: "running",
      intent: "watch test",
    });
    waiterSession = waiter.id;
    agentIdValue = team.id;
    const a = await tasks.create({
      id: taskId(),
      title: "A",
      description: "a",
      priority: "medium",
      assignee_id: ic.id,
      creator_id: team.id,
      creator_type: "agent",
    });
    const b = await tasks.create({
      id: taskId(),
      title: "B",
      description: "b",
      priority: "medium",
      assignee_id: ic.id,
      creator_id: team.id,
      creator_type: "agent",
    });
    taskA = a.id;
    taskB = b.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("create + findById round-trips with defaults", async () => {
    const id = taskWatchId();
    const created = await watches.create({
      id,
      waiter_session_id: waiterSession,
      agent_id: agentIdValue,
      mode: "all",
      task_ids: [taskA, taskB],
      reason: "checking deploy",
    });

    expect(created.status).toBe("waiting");
    expect(created.fired_at).toBeUndefined();
    expect(created.fired_session_id).toBeUndefined();
    expect(created.task_ids).toEqual([taskA, taskB]);
    expect(created.mode).toBe("all");
    expect(created.reason).toBe("checking deploy");

    const found = await watches.findById(id);
    expect(found?.id).toBe(id);
    expect(found?.task_ids).toEqual([taskA, taskB]);
  });

  it("rejects an empty task_ids array", async () => {
    await expect(
      watches.create({
        id: taskWatchId(),
        waiter_session_id: waiterSession,
        agent_id: agentIdValue,
        mode: "all",
        task_ids: [],
      }),
    ).rejects.toThrow();
  });

  it("markFired stamps fired_at + fired_session_id and is idempotent on re-call", async () => {
    const id = taskWatchId();
    await watches.create({
      id,
      waiter_session_id: waiterSession,
      agent_id: agentIdValue,
      mode: "all",
      task_ids: [taskA],
    });
    const fired = await watches.markFired(id, waiterSession);
    expect(fired.status).toBe("fired");
    expect(fired.fired_at).toBeInstanceOf(Date);
    expect(fired.fired_session_id).toBe(waiterSession);

    // Idempotent: a second call does NOT clobber the original fired_at or
    // overwrite fired_session_id with a different value.
    await new Promise((r) => setTimeout(r, 5));
    const refired = await watches.markFired(id, "sess_other");
    expect(refired.fired_at?.getTime()).toBe(fired.fired_at?.getTime());
    expect(refired.fired_session_id).toBe(waiterSession);
  });

  it("markFired throws when the watch was aborted (race with unwatch)", async () => {
    const id = taskWatchId();
    await watches.create({
      id,
      waiter_session_id: waiterSession,
      agent_id: agentIdValue,
      mode: "all",
      task_ids: [taskA],
    });
    await watches.markAborted(id);
    await expect(watches.markFired(id, waiterSession)).rejects.toThrow(
      /not in a fire-able state/,
    );
  });

  it("markAborted is idempotent on re-call but refuses on a fired watch", async () => {
    const id = taskWatchId();
    await watches.create({
      id,
      waiter_session_id: waiterSession,
      agent_id: agentIdValue,
      mode: "all",
      task_ids: [taskA],
    });
    const aborted = await watches.markAborted(id);
    expect(aborted.status).toBe("aborted");
    const aborted2 = await watches.markAborted(id);
    expect(aborted2.status).toBe("aborted");

    const fireId = taskWatchId();
    await watches.create({
      id: fireId,
      waiter_session_id: waiterSession,
      agent_id: agentIdValue,
      mode: "all",
      task_ids: [taskA],
    });
    await watches.markFired(fireId, waiterSession);
    await expect(watches.markAborted(fireId)).rejects.toThrow(
      /not in an abortable state/,
    );
  });
});
