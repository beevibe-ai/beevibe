import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "@beevibe/core/adapters/postgres";
import {
  PostgresAgentRepository,
  PostgresPersonRepository,
  PostgresSessionRepository,
  PostgresTaskRepository,
} from "@beevibe/core/adapters/postgres";
import { LocalWorkspaceManager } from "@beevibe/core/adapters/local-workspace";
import type { Agent, AgentRuntime, RuntimeRegistry, Task, Workspace } from "@beevibe/core";
import {
  DEFAULT_RUNTIME_CONFIG,
  agentId,
  personId,
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
    // 99_999_999 is well above typical pid_max; effectively guaranteed to not exist.
    expect(isProcessAlive(99_999_999)).toBe(false);
  });
});

// Fake runtime registry — `skillsDir` is the only method the workspace
// manager touches during these tests; everything else is mocked at the
// runtime-execute layer.
const fakeRuntimeRegistry: RuntimeRegistry = {
  "claude-code": {
    type: "claude-code",
    skillsDir: (workspace: Workspace) => join(workspace.path, ".claude", "skills"),
  } as unknown as AgentRuntime,
};

describe("TaskExecutionWorker", () => {
  let pool: Pool;
  let agents: PostgresAgentRepository;
  let tasks: PostgresTaskRepository;
  let sessions: PostgresSessionRepository;
  let persons: PostgresPersonRepository;
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
      status: "assigned",
      assignee_id: assigneeAgentId,
      ...overrides,
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
      pollIntervalMs: 60_000, // disable auto-polling in tests; we call poll() manually
    });
    return { worker, dispatchTask };
  }

  it("empty queue: dispatchTask is not called", async () => {
    const { worker, dispatchTask } = makeWorker();
    await worker.start();
    await worker.stop();
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("one assigned task: gets claimed and dispatched; task transitions to in_progress", async () => {
    const agent = await seedAgent();
    const task = await seedTask(agent.id);
    const { worker, dispatchTask } = makeWorker();
    await worker.start();
    await worker.stop();

    expect(dispatchTask).toHaveBeenCalledTimes(1);
    const [dispatchedTask, dispatchedAgent, dispatchedWorkspace] = dispatchTask.mock.calls[0]!;
    expect((dispatchedTask as Task).id).toBe(task.id);
    expect((dispatchedAgent as Agent).id).toBe(agent.id);
    expect((dispatchedWorkspace as Workspace).path).toBe(join(workspaceRoot, agent.id));

    const reread = await tasks.findById(task.id);
    expect(reread?.status).toBe("in_progress");
  });

  it("picks higher-priority tasks first within a single poll", async () => {
    const a1 = await seedAgent();
    const a2 = await seedAgent();
    const a3 = await seedAgent();
    const low = await seedTask(a1.id, { priority: "low" });
    const critical = await seedTask(a2.id, { priority: "critical" });
    const high = await seedTask(a3.id, { priority: "high" });

    const { worker, dispatchTask } = makeWorker();
    await worker.start();
    await worker.stop();

    expect(dispatchTask).toHaveBeenCalledTimes(3);
    const dispatchedIds = dispatchTask.mock.calls.map((c) => (c[0] as Task).id);
    expect(dispatchedIds).toEqual([critical.id, high.id, low.id]);
  });

  it("respects per-agent capacity (default 1): two tasks for same agent → only one dispatched", async () => {
    const agent = await seedAgent();
    const first = await seedTask(agent.id);
    await seedTask(agent.id);

    const { worker, dispatchTask } = makeWorker();
    await worker.start();
    await worker.stop();

    expect(dispatchTask).toHaveBeenCalledTimes(1);
    const dispatchedId = (dispatchTask.mock.calls[0]![0] as Task).id;
    expect(dispatchedId).toBe(first.id);
  });

  it("agent.max_task_sessions=2: two tasks for same agent → both dispatched in one poll", async () => {
    const agent = await seedAgent({ max_task_sessions: 2 });
    await seedTask(agent.id);
    await seedTask(agent.id);

    const { worker, dispatchTask } = makeWorker();
    await worker.start();
    await worker.stop();

    expect(dispatchTask).toHaveBeenCalledTimes(2);
  });

  it("two concurrent workers: each claim is disjoint (no double-claim)", async () => {
    const a1 = await seedAgent();
    const a2 = await seedAgent();
    await seedTask(a1.id);
    await seedTask(a2.id);

    // Dispatch stubs that just record and return — don't hold anything open.
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
      (c) => (c[0] as Task).id,
    );
    expect(new Set(allIds).size).toBe(2); // no duplicates
  });

  it("reaps orphaned sessions: dead pid → session=failed + task re-queued", async () => {
    const agent = await seedAgent();
    // Task has no assignee so the SAME poll's dispatch phase doesn't re-claim
    // it after reap re-queues it (listAssignable filters assignee_id IS NOT NULL).
    // This isolates the reap assertion.
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
    // Use the current process pid — guaranteed alive.
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

  it("cancelTask aborts an in-flight controller and returns true", async () => {
    const agent = await seedAgent();
    const task = await seedTask(agent.id);

    // Dispatch that never resolves until aborted, so the inFlight entry is live
    // when we call cancelTask().
    let abortedFromSignal = false;
    const dispatchTask = vi
      .fn<
        (task: Task, agent: Agent, ws: Workspace, signal: AbortSignal) => Promise<void>
      >()
      .mockImplementation(
        (_task, _agent, _ws, signal) =>
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
    // dispatched; cancel it
    const aborted = await worker.cancelTask(task.id);
    expect(aborted).toBe(true);
    // Let the signal-handled promise settle before stopping.
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
    await seedTask(agent.id);
    let abortedFromSignal = false;
    const dispatchTask = vi
      .fn<
        (task: Task, agent: Agent, ws: Workspace, signal: AbortSignal) => Promise<void>
      >()
      .mockImplementation(
        (_task, _agent, _ws, signal) =>
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

  it("needs_revision tasks are picked up and claimed into revision state", async () => {
    const agent = await seedAgent();
    const task = await seedTask(agent.id, { status: "needs_revision" });
    const { worker, dispatchTask } = makeWorker();
    await worker.start();
    await worker.stop();
    expect(dispatchTask).toHaveBeenCalledTimes(1);
    const dispatched = dispatchTask.mock.calls[0]![0] as Task;
    expect(dispatched.id).toBe(task.id);
    // Post-claim status signals dispatch to set priorSessionId for --resume.
    expect(dispatched.status).toBe("revision");
  });

  it("reap of a dead session whose task is in `revision` resets task to `needs_revision` (not `assigned`)", async () => {
    const agent = await seedAgent();
    // Task in running re-work state, no assignee so dispatch doesn't reclaim
    // in the same poll (mirrors the trick used by the assigned-reap test).
    const task = await tasks.create({
      id: taskId(),
      title: "orphaned revision",
      priority: "medium",
      creator_id: ownerPersonId,
      creator_type: "person",
      status: "revision",
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

    const rereadSession = await sessions.findById(sess.id);
    expect(rereadSession?.status).toBe("failed");
    const rereadTask = await tasks.findById(task.id);
    expect(rereadTask?.status).toBe("needs_revision");
  });

  it("default poll interval is 30_000ms when not configured", async () => {
    vi.useFakeTimers();
    try {
      const pollSpy = vi.fn<() => Promise<void>>();
      // Reach into private via subclass to count timer firings explicitly.
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
      // start() runs one immediate poll (awaited) then schedules the interval.
      await worker.start();
      expect(pollSpy).toHaveBeenCalledTimes(1);
      // Advance one full default interval → one more poll.
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_MS);
      expect(pollSpy).toHaveBeenCalledTimes(2);
      await worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("capacity defaults to DEFAULT_TASK_CAP when agent.max_task_sessions is undefined", () => {
    expect(DEFAULT_TASK_CAP).toBe(1);
  });
});
