import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../domain/agent.js";
import {
  agentId,
  personId,
  sessionId,
  taskId,
} from "../domain/ids.js";
import { createTestPool, truncateAll } from "../test-helpers.js";
import type { Pool } from "../adapters/postgres/client.js";
import { PostgresAgentRepository } from "../adapters/postgres/agent-repo.js";
import { PostgresPersonRepository } from "../adapters/postgres/person-repo.js";
import { PostgresSessionRepository } from "../adapters/postgres/session-repo.js";
import { PostgresTaskRepository } from "../adapters/postgres/task-repo.js";
import { PostgresTaskWatchRepository } from "../adapters/postgres/task-watch-repo.js";
import {
  WatchAuthError,
  WatchNotFoundError,
  WatchService,
  WatchValidationError,
} from "./watch-service.js";

describe("WatchService — integration", () => {
  let pool: Pool;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let sessions: PostgresSessionRepository;
  let tasks: PostgresTaskRepository;
  let watches: PostgresTaskWatchRepository;
  let svc: WatchService;

  let teamAgentId: string;
  let icAgentId: string;
  let waiterSessionId: string;

  beforeAll(() => {
    pool = createTestPool();
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
    sessions = new PostgresSessionRepository(pool);
    tasks = new PostgresTaskRepository(pool);
    watches = new PostgresTaskWatchRepository(pool);
    svc = new WatchService({
      pool,
      sessionRepo: sessions,
      taskRepo: tasks,
      watchRepo: watches,
    });
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
      status: "succeeded",
      intent: "watch test",
    });
    teamAgentId = team.id;
    icAgentId = ic.id;
    waiterSessionId = waiter.id;
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Dispatch a task by inserting a task row + an IC session parented to the
   *  given waiter session — mirrors what create_task does. */
  async function dispatchTask(
    title: string,
    parentSessionId: string,
    opts: { status?: "in_progress" | "done" | "failed" | "cancelled" } = {},
  ): Promise<string> {
    const t = await tasks.create({
      id: taskId(),
      title,
      description: title.toLowerCase(),
      priority: "medium",
      assignee_id: icAgentId,
      creator_id: teamAgentId,
      creator_type: "agent",
      status: opts.status ?? "in_progress",
    });
    await sessions.create({
      id: sessionId(),
      agent_id: icAgentId,
      task_id: t.id,
      parent_session_id: parentSessionId,
      type: "task",
      status: "running",
      intent: `<task id="${t.id}"/>`,
    });
    return t.id;
  }

  describe("watchTasks", () => {
    it("creates a waiting watch on dispatched tasks in the chain", async () => {
      const a = await dispatchTask("A", waiterSessionId);
      const b = await dispatchTask("B", waiterSessionId);

      const result = await svc.watchTasks({
        callerAgentId: teamAgentId,
        callerSessionId: waiterSessionId,
        taskIds: [a, b],
        mode: "all",
      });

      expect(result.firedImmediately).toBe(false);
      const watch = await watches.findById(result.watchId);
      expect(watch?.status).toBe("waiting");
      expect(watch?.task_ids).toEqual([a, b]);
    });

    it("auth: rejects when caller_agent_id mismatches the waiter session", async () => {
      const a = await dispatchTask("A", waiterSessionId);
      await expect(
        svc.watchTasks({
          callerAgentId: icAgentId,
          callerSessionId: waiterSessionId,
          taskIds: [a],
          mode: "all",
        }),
      ).rejects.toThrow(WatchAuthError);
    });

    it("auth: rejects when the waiter session does not exist", async () => {
      const a = await dispatchTask("A", waiterSessionId);
      await expect(
        svc.watchTasks({
          callerAgentId: teamAgentId,
          callerSessionId: "sess_nonexistent",
          taskIds: [a],
          mode: "all",
        }),
      ).rejects.toThrow(WatchAuthError);
    });

    it("auth: rejects when a task was dispatched outside the chain", async () => {
      // Another team session (a different conversation) dispatches the task.
      const otherWaiter = await sessions.create({
        id: sessionId(),
        agent_id: teamAgentId,
        type: "chat",
        status: "succeeded",
        intent: "another conversation",
      });
      const orphanTask = await dispatchTask("Orphan", otherWaiter.id);
      await expect(
        svc.watchTasks({
          callerAgentId: teamAgentId,
          callerSessionId: waiterSessionId,
          taskIds: [orphanTask],
          mode: "all",
        }),
      ).rejects.toThrow(/not dispatched in your conversation chain/);
    });

    it("auth: accepts tasks dispatched in an EARLIER turn of the same chain", async () => {
      // First chat turn dispatches the task, then a second turn calls
      // watch_tasks; the chain walk should let it through.
      const a = await dispatchTask("A", waiterSessionId);
      const turn2 = await sessions.create({
        id: sessionId(),
        agent_id: teamAgentId,
        type: "chat",
        status: "succeeded",
        intent: "turn 2",
        prior_session_id: waiterSessionId,
      });
      const result = await svc.watchTasks({
        callerAgentId: teamAgentId,
        callerSessionId: turn2.id,
        taskIds: [a],
        mode: "all",
      });
      const watch = await watches.findById(result.watchId);
      expect(watch?.task_ids).toEqual([a]);
    });

    it("rejects empty task_ids", async () => {
      await expect(
        svc.watchTasks({
          callerAgentId: teamAgentId,
          callerSessionId: waiterSessionId,
          taskIds: [],
          mode: "all",
        }),
      ).rejects.toThrow(WatchValidationError);
    });

    it("fires immediately when mode='any' and at least one task is already terminal", async () => {
      const a = await dispatchTask("A", waiterSessionId, { status: "done" });
      const b = await dispatchTask("B", waiterSessionId);
      // Set result_summary so the intent formatter has something to include.
      await tasks.update(a, { result_summary: "shipped a" });

      const result = await svc.watchTasks({
        callerAgentId: teamAgentId,
        callerSessionId: waiterSessionId,
        taskIds: [a, b],
        mode: "any",
      });

      expect(result.firedImmediately).toBe(true);
      const watch = await watches.findById(result.watchId);
      expect(watch?.status).toBe("fired");
      const wake = await sessions.findById(watch!.fired_session_id!);
      expect(wake?.prior_session_id).toBe(waiterSessionId);
      expect(wake?.status).toBe("pending");
      expect(wake?.intent).toContain("Task A — done. Result: shipped a");
      expect(wake?.intent).toContain("Other watched tasks still running");
    });

    it("fires immediately when mode='all' and every task is already terminal", async () => {
      const a = await dispatchTask("A", waiterSessionId, { status: "done" });
      const b = await dispatchTask("B", waiterSessionId, { status: "failed" });
      await tasks.update(a, { result_summary: "shipped a" });
      await tasks.update(b, { result_summary: "tests broke" });

      const result = await svc.watchTasks({
        callerAgentId: teamAgentId,
        callerSessionId: waiterSessionId,
        taskIds: [a, b],
        mode: "all",
      });

      expect(result.firedImmediately).toBe(true);
      const watch = await watches.findById(result.watchId);
      const wake = await sessions.findById(watch!.fired_session_id!);
      expect(wake?.intent).toContain("2 tasks completed:");
      expect(wake?.intent).toContain("A — done. Result: shipped a");
      expect(wake?.intent).toContain("B — failed: tests broke");
      // Wrapped so chainToMessages can detect and skip the user-bubble.
      expect(wake?.intent.startsWith("<system-wake>")).toBe(true);
      expect(wake?.intent.endsWith("</system-wake>")).toBe(true);
    });

    it("inherits the waiter's runtime_id on the already-terminal fire path", async () => {
      // Already-terminal race goes through WatchService.fireWatch, NOT
      // the SQL trigger. Both paths must pin the wake to the same
      // runtime so a chat conversation's daemon claims the wake instead
      // of the server-fallback worker.
      const suffix = Date.now();
      const ownerRow = await pool.query<{ owner_id: string }>(
        `SELECT owner_id FROM agent WHERE id = $1`,
        [teamAgentId],
      );
      const personId_ = ownerRow.rows[0]!.owner_id;
      const daemonIdValue = `dmn_pin_${suffix}`;
      const rt = `rt_pin_${suffix}`;
      await pool.query(
        `INSERT INTO daemon (id, owner_person_id, external_id, device_name, token_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [daemonIdValue, personId_, `ext_${suffix}`, `dev_${suffix}`, `hash_${suffix}`],
      );
      await pool.query(
        `INSERT INTO runtime (id, daemon_id, cli, capabilities)
         VALUES ($1, $2, 'claude', '{}'::jsonb)`,
        [rt, daemonIdValue],
      );
      const pinnedWaiter = await sessions.create({
        id: sessionId(),
        agent_id: teamAgentId,
        type: "chat",
        status: "succeeded",
        intent: "pinned",
        runtime_id: rt,
      });
      const a = await dispatchTask("A", pinnedWaiter.id, { status: "done" });
      await tasks.update(a, { result_summary: "shipped" });

      const result = await svc.watchTasks({
        callerAgentId: teamAgentId,
        callerSessionId: pinnedWaiter.id,
        taskIds: [a],
        mode: "all",
      });

      expect(result.firedImmediately).toBe(true);
      const watch = await watches.findById(result.watchId);
      const wake = await sessions.findById(watch!.fired_session_id!);
      expect(wake?.runtime_id).toBe(rt);
    });

    it("does not fire when mode='all' and only some tasks are terminal", async () => {
      const a = await dispatchTask("A", waiterSessionId, { status: "done" });
      const b = await dispatchTask("B", waiterSessionId);

      const result = await svc.watchTasks({
        callerAgentId: teamAgentId,
        callerSessionId: waiterSessionId,
        taskIds: [a, b],
        mode: "all",
      });

      expect(result.firedImmediately).toBe(false);
      const watch = await watches.findById(result.watchId);
      expect(watch?.status).toBe("waiting");
    });
  });

  describe("unwatch", () => {
    it("aborts a waiting watch", async () => {
      const a = await dispatchTask("A", waiterSessionId);
      const { watchId } = await svc.watchTasks({
        callerAgentId: teamAgentId,
        callerSessionId: waiterSessionId,
        taskIds: [a],
        mode: "all",
      });
      await svc.unwatch({ callerAgentId: teamAgentId, watchId });
      const watch = await watches.findById(watchId);
      expect(watch?.status).toBe("aborted");
    });

    it("is idempotent on an already-aborted watch", async () => {
      const a = await dispatchTask("A", waiterSessionId);
      const { watchId } = await svc.watchTasks({
        callerAgentId: teamAgentId,
        callerSessionId: waiterSessionId,
        taskIds: [a],
        mode: "all",
      });
      await svc.unwatch({ callerAgentId: teamAgentId, watchId });
      await expect(
        svc.unwatch({ callerAgentId: teamAgentId, watchId }),
      ).resolves.toBeUndefined();
    });

    it("refuses to abort a fired watch", async () => {
      const a = await dispatchTask("A", waiterSessionId, { status: "done" });
      const { watchId } = await svc.watchTasks({
        callerAgentId: teamAgentId,
        callerSessionId: waiterSessionId,
        taskIds: [a],
        mode: "all",
      });
      await expect(
        svc.unwatch({ callerAgentId: teamAgentId, watchId }),
      ).rejects.toThrow(WatchValidationError);
    });

    it("auth: rejects when caller does not own the watch", async () => {
      const a = await dispatchTask("A", waiterSessionId);
      const { watchId } = await svc.watchTasks({
        callerAgentId: teamAgentId,
        callerSessionId: waiterSessionId,
        taskIds: [a],
        mode: "all",
      });
      await expect(
        svc.unwatch({ callerAgentId: icAgentId, watchId }),
      ).rejects.toThrow(WatchAuthError);
    });

    it("throws WatchNotFoundError for an unknown id", async () => {
      await expect(
        svc.unwatch({ callerAgentId: teamAgentId, watchId: "watch_missing" }),
      ).rejects.toThrow(WatchNotFoundError);
    });
  });
});
