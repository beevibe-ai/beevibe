/**
 * Phase 4 worker tests. The worker now claims pending sessions whose
 * `runtime_id IS NULL` (legacy / unbound agents) instead of polling
 * tasks. Daemon-bound sessions (runtime_id set) are claimed by the
 * matching daemon and never reach this loop.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  PostgresAgentRepository,
  PostgresDaemonRepository,
  PostgresPersonRepository,
  PostgresRuntimeRepository,
  PostgresSessionRepository,
  PostgresTaskRepository,
} from "@beevibe/core/adapters/postgres";
import { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import type {
  Agent,
  AgentRuntime,
  RuntimeRegistry,
  Session,
  Task,
  Workspace,
} from "@beevibe/core";
import {
  DEFAULT_RUNTIME_CONFIG,
  agentId,
  daemonId as makeDaemonId,
  personId,
  runtimeId as makeRuntimeId,
  sessionId,
  taskId,
} from "@beevibe/core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import {
  DEFAULT_POLL_MS,
  DEFAULT_TASK_CAP,
  TaskExecutionWorker,
  isProcessAlive,
} from "./worker.js";

describe("isProcessAlive", () => {
  it("returns false for invalid pids", () => {
    expect(isProcessAlive(null)).toBe(false);
    expect(isProcessAlive(undefined)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });

  it("returns true for the current process pid", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for a non-existent pid", () => {
    expect(isProcessAlive(99_999_999)).toBe(false);
  });
});

const fakeRuntimeRegistry: RuntimeRegistry = {
  "claude": {
    type: "claude",
    skillsDir: (workspace: Workspace) => join(workspace.path, ".claude", "skills"),
  } as unknown as AgentRuntime,
};

describe("TaskExecutionWorker (Phase 4 — session-based claim)", () => {
  let pool: Pool;
  let agents: PostgresAgentRepository;
  let tasks: PostgresTaskRepository;
  let sessions: PostgresSessionRepository;
  let persons: PostgresPersonRepository;
  let daemons: PostgresDaemonRepository;
  let runtimes: PostgresRuntimeRepository;
  let workspaceRoot: string;
  let skillsSourceDir: string;
  let workspaceManager: LocalWorkspaceManager;
  let ownerPersonId: string;

  beforeAll(() => {
    pool = createTestPool();
    agents = new PostgresAgentRepository(pool);
    tasks = new PostgresTaskRepository(pool);
    sessions = new PostgresSessionRepository(pool);
    persons = new PostgresPersonRepository(pool);
    daemons = new PostgresDaemonRepository(pool);
    runtimes = new PostgresRuntimeRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const owner = await persons.create({ id: personId(), name: "Worker Owner" });
    ownerPersonId = owner.id;
    workspaceRoot = mkdtempSync(join(tmpdir(), "beevibe-worker-test-"));
    skillsSourceDir = mkdtempSync(join(tmpdir(), "beevibe-skills-src-"));
    workspaceManager = new LocalWorkspaceManager({
      workspaceRoot,
      mcpServerUrl: "http://mcp.test.invalid/",
      runtimeRegistry: fakeRuntimeRegistry,
      skillsSourceDir,
    });
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(skillsSourceDir, { recursive: true, force: true });
  });

  async function seedAgent(overrides: Partial<Agent> = {}): Promise<Agent> {
    return agents.create({
      id: agentId(),
      name: "Agent",
      owner_id: ownerPersonId,
      hierarchy_level: "ic",
      api_key: `bv_a_test_${Math.random().toString(36).slice(2, 10)}`,
      runtime_config: DEFAULT_RUNTIME_CONFIG,
      ...overrides,
    });
  }

  async function seedRuntime(): Promise<string> {
    const dId = makeDaemonId();
    await daemons.create({
      id: dId,
      owner_person_id: ownerPersonId,
      external_id: "host",
      device_name: "Host",
      token_hash: "t",
    });
    const rId = makeRuntimeId();
    await runtimes.create({ id: rId, daemon_id: dId, cli: "claude" });
    return rId;
  }

  async function seedTask(
    assigneeAgentId: string,
    overrides: Partial<Task> = {},
  ): Promise<Task> {
    return tasks.create({
      id: taskId(),
      title: "Do X",
      priority: "medium",
      creator_id: ownerPersonId,
      creator_type: "person",
      status: "in_progress",
      assignee_id: assigneeAgentId,
      ...overrides,
    });
  }

  async function seedPendingSession(
    agentId: string,
    overrides: Partial<{ task_id: string; runtime_id: string; type: Session["type"] }> = {},
  ): Promise<Session> {
    return sessions.create({
      id: sessionId(),
      agent_id: agentId,
      type: overrides.type ?? "task",
      status: "pending",
      intent: "do the thing",
      task_id: overrides.task_id,
      runtime_id: overrides.runtime_id,
    });
  }

  function makeWorker(dispatchTask = vi.fn().mockResolvedValue(undefined)): {
    worker: TaskExecutionWorker;
    dispatchTask: ReturnType<typeof vi.fn>;
  } {
    const worker = new TaskExecutionWorker({
      agentRepo: agents,
      taskRepo: tasks,
      sessionRepo: sessions,
      workspaceManager,
      dispatchTask,
      pollIntervalMs: 60_000,
    });
    return { worker, dispatchTask };
  }

  it("empty queue: dispatchTask is not called", async () => {
    const { worker, dispatchTask } = makeWorker();
    await worker.start();
    await worker.stop();
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("one null-runtime pending session: claimed, promoted to running, dispatched", async () => {
    const agent = await seedAgent();
    const task = await seedTask(agent.id);
    const session = await seedPendingSession(agent.id, { task_id: task.id });

    const { worker, dispatchTask } = makeWorker();
    await worker.start();
    await worker.stop();

    expect(dispatchTask).toHaveBeenCalledTimes(1);
    const [dispatchedSession, dispatchedAgent, dispatchedWorkspace] =
      dispatchTask.mock.calls[0]!;
    expect((dispatchedSession as Session).id).toBe(session.id);
    expect((dispatchedSession as Session).status).toBe("running");
    expect((dispatchedAgent as Agent).id).toBe(agent.id);
    expect((dispatchedWorkspace as Workspace).path).toBe(join(workspaceRoot, agent.id));

    const reread = await sessions.findById(session.id);
    expect(reread?.status).toBe("running");
    expect(reread?.started_at).toBeInstanceOf(Date);
  });

  it("daemon-bound sessions (runtime_id set) are NOT claimed by the executor", async () => {
    const agent = await seedAgent();
    const rId = await seedRuntime();
    await seedPendingSession(agent.id, { runtime_id: rId });

    const { worker, dispatchTask } = makeWorker();
    await worker.start();
    await worker.stop();
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("multiple null-runtime sessions: claimed in created_at order", async () => {
    const a1 = await seedAgent();
    const a2 = await seedAgent();
    const a3 = await seedAgent();
    const s1 = await seedPendingSession(a1.id);
    await new Promise((r) => setTimeout(r, 5));
    const s2 = await seedPendingSession(a2.id);
    await new Promise((r) => setTimeout(r, 5));
    const s3 = await seedPendingSession(a3.id);

    const { worker, dispatchTask } = makeWorker();
    await worker.start();
    await worker.stop();

    expect(dispatchTask).toHaveBeenCalledTimes(3);
    const ids = dispatchTask.mock.calls.map((c) => (c[0] as Session).id);
    expect(ids).toEqual([s1.id, s2.id, s3.id]);
  });

  it("respects per-agent task cap: second session for same agent released back to pending", async () => {
    const agent = await seedAgent({ max_task_sessions: 1 });
    // First session claims and stays running (mock dispatch never resolves).
    let block: () => void = () => undefined;
    const dispatchTask = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { block = resolve; }))
      .mockResolvedValue(undefined);

    const s1 = await seedPendingSession(agent.id);
    const s2 = await seedPendingSession(agent.id);

    const worker = new TaskExecutionWorker({
      agentRepo: agents,
      taskRepo: tasks,
      sessionRepo: sessions,
      workspaceManager,
      dispatchTask,
      pollIntervalMs: 60_000,
    });
    await worker.start();
    // Give s1 a moment to be in-flight.
    await new Promise((r) => setTimeout(r, 30));

    // s1 dispatched; s2 should be back in pending.
    expect(dispatchTask).toHaveBeenCalledTimes(1);
    const reread = await sessions.findById(s2.id);
    expect(reread?.status).toBe("pending");
    const r1 = await sessions.findById(s1.id);
    expect(r1?.status).toBe("running");

    block();
    await worker.stop();
  });

  it("two concurrent workers: each claim is disjoint (no double-dispatch)", async () => {
    const a1 = await seedAgent();
    const a2 = await seedAgent();
    await seedPendingSession(a1.id);
    await seedPendingSession(a2.id);

    const dispatchA = vi.fn().mockResolvedValue(undefined);
    const dispatchB = vi.fn().mockResolvedValue(undefined);
    const workerA = new TaskExecutionWorker({
      agentRepo: agents,
      taskRepo: tasks,
      sessionRepo: sessions,
      workspaceManager,
      dispatchTask: dispatchA,
      pollIntervalMs: 60_000,
    });
    const workerB = new TaskExecutionWorker({
      agentRepo: agents,
      taskRepo: tasks,
      sessionRepo: sessions,
      workspaceManager,
      dispatchTask: dispatchB,
      pollIntervalMs: 60_000,
    });
    await Promise.all([workerA.start(), workerB.start()]);
    await Promise.all([workerA.stop(), workerB.stop()]);

    const total = dispatchA.mock.calls.length + dispatchB.mock.calls.length;
    expect(total).toBe(2);
    const allIds = [...dispatchA.mock.calls, ...dispatchB.mock.calls].map(
      (c) => (c[0] as Session).id,
    );
    expect(new Set(allIds).size).toBe(2);
  });

  it("reaps orphaned sessions: dead pid → session=failed + task re-queued", async () => {
    const agent = await seedAgent();
    const task = await tasks.create({
      id: taskId(),
      title: "orphaned",
      priority: "medium",
      creator_id: ownerPersonId,
      creator_type: "person",
      status: "in_progress",
    });
    const deadPid = 99_999_999;
    const sess = await sessions.create({
      id: sessionId(),
      agent_id: agent.id,
      task_id: task.id,
      type: "task",
      intent: "x",
      process_pid: deadPid,
      process_group_id: deadPid,
      status: "running",
      started_at: new Date(),
    });

    const { worker } = makeWorker();
    await worker.start();
    await worker.stop();

    const reread = await sessions.findById(sess.id);
    expect(reread?.status).toBe("failed");
    expect(reread?.error).toBe("process_lost");
    const rereadTask = await tasks.findById(task.id);
    expect(rereadTask?.status).toBe("assigned");
  });

  it("reap skips live sessions", async () => {
    const agent = await seedAgent();
    const task = await seedTask(agent.id, { status: "in_progress" });
    const sess = await sessions.create({
      id: sessionId(),
      agent_id: agent.id,
      task_id: task.id,
      type: "task",
      intent: "x",
      process_pid: process.pid,
      process_group_id: process.pid,
      status: "running",
      started_at: new Date(),
    });

    const { worker } = makeWorker();
    await worker.start();
    await worker.stop();

    const reread = await sessions.findById(sess.id);
    expect(reread?.status).toBe("running");
  });

  it("cancelTask aborts the in-flight controller for a task's latest session", async () => {
    const agent = await seedAgent();
    const task = await seedTask(agent.id);
    await seedPendingSession(agent.id, { task_id: task.id });

    let abortedFromSignal = false;
    const dispatchTask = vi
      .fn<
        (s: Session, a: Agent, ws: Workspace, signal: AbortSignal) => Promise<void>
      >()
      .mockImplementation(
        (_s, _a, _ws, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              abortedFromSignal = true;
              resolve();
            });
          }),
      );

    const worker = new TaskExecutionWorker({
      agentRepo: agents,
      taskRepo: tasks,
      sessionRepo: sessions,
      workspaceManager,
      dispatchTask,
      pollIntervalMs: 60_000,
    });
    await worker.start();
    // Let the dispatch loop register the in-flight controller.
    await new Promise((r) => setTimeout(r, 20));
    const aborted = await worker.cancelTask(task.id);
    expect(aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(abortedFromSignal).toBe(true);
    await worker.stop();
  });

  it("cancelTask returns false when task is not in flight", async () => {
    const { worker } = makeWorker();
    await worker.start();
    const aborted = await worker.cancelTask("task_nonexistent");
    expect(aborted).toBe(false);
    await worker.stop();
  });

  it("stop() aborts in-flight controllers", async () => {
    const agent = await seedAgent();
    await seedPendingSession(agent.id);
    let abortedFromSignal = false;
    const dispatchTask = vi
      .fn<
        (s: Session, a: Agent, ws: Workspace, signal: AbortSignal) => Promise<void>
      >()
      .mockImplementation(
        (_s, _a, _ws, signal) =>
          new Promise((resolve) => {
            signal.addEventListener("abort", () => {
              abortedFromSignal = true;
              resolve();
            });
          }),
      );
    const worker = new TaskExecutionWorker({
      agentRepo: agents,
      taskRepo: tasks,
      sessionRepo: sessions,
      workspaceManager,
      dispatchTask,
      pollIntervalMs: 60_000,
    });
    await worker.start();
    await worker.stop();
    await new Promise((r) => setTimeout(r, 10));
    expect(abortedFromSignal).toBe(true);
  });

  it("default poll interval is 30_000ms when not configured", async () => {
    vi.useFakeTimers();
    try {
      const pollSpy = vi.fn<() => Promise<void>>();
      class SpyWorker extends TaskExecutionWorker {
        override async poll(): Promise<void> {
          pollSpy();
          return super.poll();
        }
      }
      const worker = new SpyWorker({
        agentRepo: agents,
        taskRepo: tasks,
        sessionRepo: sessions,
        workspaceManager,
        dispatchTask: vi.fn().mockResolvedValue(undefined),
      });
      await worker.start();
      expect(pollSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS);
      expect(pollSpy).toHaveBeenCalledTimes(2);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("DEFAULT_TASK_CAP is 1", () => {
    expect(DEFAULT_TASK_CAP).toBe(1);
  });
});
