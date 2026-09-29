/**
 * TaskExecutionWorker — fake-backed unit tests.
 *
 * `worker.test.ts` is the DB-backed suite: it exercises the real SQL
 * claim semantics (per-agent cap, created_at ordering, two concurrent
 * workers claiming disjointly) against Postgres, and needs
 * DATABASE_URL_TEST to run at all.
 *
 * This file is the complement, not a replacement. Every collaborator
 * arrives through `TaskExecutionWorkerConfig`, so the loop's error and
 * edge branches — the ones a happy-path integration test never reaches —
 * are reachable with fakes and no database: `isProcessAlive`'s errno
 * handling, the default `onError`, a non-Error dispatch rejection, the
 * reap requeue table's non-default arms, and `agent_missing_at_claim`.
 * Cases the DB suite already owns are deliberately not repeated here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  Session,
  SessionRepository,
  Task,
  TaskRepository,
  Workspace,
  WorkspaceManager,
} from "@beevibe/core";
import { TaskExecutionWorker, isProcessAlive, type DispatchFn } from "./worker.js";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_test",
    name: "Agent",
    owner_id: "person_owner",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_test",
    agent_id: "agent_test",
    type: "task",
    status: "running",
    intent: "<task>do a thing</task>",
    created_at: new Date(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_test",
    title: "A task",
    status: "assigned",
    priority: "medium",
    creator_id: "person_owner",
    creator_type: "human",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const WORKSPACE: Workspace = { path: "/tmp/ws" };

let agentRepo: AgentRepository;
let taskRepo: TaskRepository;
let sessionRepo: SessionRepository;
let workspaceManager: WorkspaceManager;
let dispatchTask: ReturnType<typeof vi.fn>;
let onError: ReturnType<typeof vi.fn>;

/** Let the fire-and-forget dispatch chain settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  agentRepo = {
    findById: vi.fn().mockResolvedValue(makeAgent()),
    findByApiKey: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findByLevel: vi.fn(),
    findParent: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as AgentRepository;

  taskRepo = {
    findById: vi.fn().mockResolvedValue(undefined),
    findByIds: vi.fn(),
    list: vi.fn(),
    listByAssignee: vi.fn(),
    listAssignable: vi.fn().mockResolvedValue([]),
    claimById: vi.fn(),
    listReviewQueue: vi.fn(),
    countChildrenNotComplete: vi.fn(),
    countChildren: vi.fn(),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue(makeTask()),
    updateProgress: vi.fn(),
    markBlocked: vi.fn(),
    clearBlocker: vi.fn(),
    delete: vi.fn(),
  } as unknown as TaskRepository;

  sessionRepo = {
    findById: vi.fn(),
    findLatestForTask: vi.fn().mockResolvedValue(undefined),
    listForTask: vi.fn(),
    listForAgent: vi.fn(),
    countRunningByAgent: vi.fn(),
    listRunningWithPid: vi.fn().mockResolvedValue([]),
    claimNextForRuntime: vi.fn(),
    claimNextForServerFallback: vi.fn().mockResolvedValue(undefined),
    countOwnedByDaemon: vi.fn(),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue(makeSession()),
  } as unknown as SessionRepository;

  workspaceManager = {
    ensureWorkspace: vi.fn().mockResolvedValue(WORKSPACE),
    removeWorkspace: vi.fn(),
  } as unknown as WorkspaceManager;

  dispatchTask = vi.fn().mockResolvedValue(undefined);
  onError = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeWorker(overrides: Partial<{ pollIntervalMs: number }> = {}) {
  return new TaskExecutionWorker({
    agentRepo,
    taskRepo,
    sessionRepo,
    workspaceManager,
    dispatchTask: dispatchTask as unknown as DispatchFn,
    onError,
    ...overrides,
  });
}

describe("isProcessAlive", () => {


  it("treats EPERM as alive — the process exists under another uid", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    expect(isProcessAlive(4242)).toBe(true);
  });

  it("treats ESRCH as dead", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    expect(isProcessAlive(4242)).toBe(false);
  });

  it("treats an error with no code as dead rather than throwing", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("something else");
    });
    expect(isProcessAlive(4242)).toBe(false);
  });
});

describe("TaskExecutionWorker.status", () => {

  it("honours a configured poll interval", () => {
    expect(makeWorker({ pollIntervalMs: 500 }).status().pollIntervalMs).toBe(500);
  });

  it("reports running + lastPollAt once started", async () => {
    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    const status = worker.status();
    expect(status.running).toBe(true);
    expect(status.lastPollAt).toBeInstanceOf(Date);
    await worker.stop();
  });
});

describe("TaskExecutionWorker start/stop", () => {
  it("polls immediately on start, then on every interval tick", async () => {
    vi.useFakeTimers();
    const worker = makeWorker({ pollIntervalMs: 1_000 });
    await worker.start();
    expect(sessionRepo.listRunningWithPid).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionRepo.listRunningWithPid).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sessionRepo.listRunningWithPid).toHaveBeenCalledTimes(4);
    await worker.stop();
  });

  it("is idempotent — a second start does not add a second poll loop", async () => {
    vi.useFakeTimers();
    const worker = makeWorker({ pollIntervalMs: 1_000 });
    await worker.start();
    await worker.start();
    expect(sessionRepo.listRunningWithPid).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionRepo.listRunningWithPid).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it("routes a poll rejection from the interval to onError without killing the loop", async () => {
    vi.useFakeTimers();
    const worker = makeWorker({ pollIntervalMs: 1_000 });
    await worker.start();

    const boom = new Error("db down");
    vi.mocked(sessionRepo.listRunningWithPid).mockRejectedValueOnce(boom);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledWith(boom);

    // Loop survives: the next tick polls again.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sessionRepo.listRunningWithPid).toHaveBeenCalledTimes(3);
    await worker.stop();
  });

  it("stop clears the timer so no further polls fire", async () => {
    vi.useFakeTimers();
    const worker = makeWorker({ pollIntervalMs: 1_000 });
    await worker.start();
    await worker.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sessionRepo.listRunningWithPid).toHaveBeenCalledTimes(1);
    expect(worker.status().running).toBe(false);
  });

  it("stop is safe before start", async () => {
    await expect(makeWorker().stop()).resolves.toBeUndefined();
  });

  it("poll is a no-op while stopped", async () => {
    const worker = makeWorker();
    await worker.poll();
    expect(sessionRepo.listRunningWithPid).not.toHaveBeenCalled();
    expect(worker.status().lastPollAt).toBeNull();
  });

});

describe("TaskExecutionWorker reap", () => {

  it("re-queues revision → needs_revision", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("gone") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    vi.mocked(sessionRepo.listRunningWithPid).mockResolvedValue([
      makeSession({ id: "sess_dead", task_id: "task_1", process_pid: 9999 }),
    ]);
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ id: "task_1", status: "revision" }),
    );

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    expect(taskRepo.update).toHaveBeenCalledWith("task_1", { status: "needs_revision" });
    await worker.stop();
  });

  it("leaves a terminal task status alone — reap never overwrites done/cancelled", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("gone") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    vi.mocked(sessionRepo.listRunningWithPid).mockResolvedValue([
      makeSession({ id: "sess_dead", task_id: "task_1", process_pid: 9999 }),
    ]);
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ id: "task_1", status: "done" }),
    );

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    expect(sessionRepo.update).toHaveBeenCalledOnce();
    expect(taskRepo.update).not.toHaveBeenCalled();
    await worker.stop();
  });

  it("fails the session but skips the task write when the task row is gone", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("gone") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    vi.mocked(sessionRepo.listRunningWithPid).mockResolvedValue([
      makeSession({ id: "sess_dead", task_id: "task_missing", process_pid: 9999 }),
    ]);
    vi.mocked(taskRepo.findById).mockResolvedValue(undefined);

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    expect(sessionRepo.update).toHaveBeenCalledOnce();
    expect(taskRepo.update).not.toHaveBeenCalled();
    await worker.stop();
  });

  it("fails a task-less session without touching the task repo at all", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("gone") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    vi.mocked(sessionRepo.listRunningWithPid).mockResolvedValue([
      makeSession({ id: "sess_chat", task_id: undefined, process_pid: 9999 }),
    ]);

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    expect(sessionRepo.update).toHaveBeenCalledWith("sess_chat", {
      status: "failed",
      error: "process_lost",
      completed_at: expect.any(Date),
    });
    expect(taskRepo.findById).not.toHaveBeenCalled();
    await worker.stop();
  });


  it("skips a candidate whose task_id is a key in the in-flight map", async () => {
    // The reap guard reads `inFlight.has(session.task_id)`, while the map is
    // keyed by *session* id (see dispatchReady / cancelTask). Reaching the
    // `continue` therefore needs a session id that equals the reap
    // candidate's task_id — contrived, but it pins the branch as written.
    dispatchTask.mockImplementation(() => new Promise(() => {}));
    vi.mocked(sessionRepo.claimNextForServerFallback)
      .mockResolvedValueOnce(makeSession({ id: "task_1", task_id: undefined }))
      .mockResolvedValue(undefined);
    vi.mocked(sessionRepo.listRunningWithPid).mockResolvedValue([
      makeSession({ id: "sess_dead", task_id: "task_1", process_pid: 9999 }),
    ]);

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    expect(worker.status().inFlightCount).toBe(1);

    // The first poll (inside start) reaps before dispatch populates the
    // map, so clear that round out before asserting on the second.
    vi.mocked(sessionRepo.update).mockClear();
    const killSpy = vi.spyOn(process, "kill");

    // Second poll: the reap candidate is skipped by the guard, so no
    // process liveness check and no session write.
    await worker.poll();
    expect(killSpy).not.toHaveBeenCalled();
    expect(sessionRepo.update).not.toHaveBeenCalled();
    await worker.stop();
  });
});

describe("TaskExecutionWorker dispatch", () => {
  it("drains the claim queue and dispatches each session with its workspace", async () => {
    const first = makeSession({ id: "sess_1", task_id: "task_1" });
    const second = makeSession({ id: "sess_2", task_id: "task_2" });
    vi.mocked(sessionRepo.claimNextForServerFallback)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValue(undefined);
    const agent = makeAgent({ id: "agent_1" });
    vi.mocked(agentRepo.findById).mockResolvedValue(agent);

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    await flush();

    expect(dispatchTask).toHaveBeenCalledTimes(2);
    expect(dispatchTask).toHaveBeenNthCalledWith(
      1,
      first,
      agent,
      WORKSPACE,
      expect.any(AbortSignal),
    );
    expect(dispatchTask).toHaveBeenNthCalledWith(
      2,
      second,
      agent,
      WORKSPACE,
      expect.any(AbortSignal),
    );
    expect(workspaceManager.ensureWorkspace).toHaveBeenCalledWith({ agent });
    await worker.stop();
  });


  it("fails the session and keeps draining when the agent vanished mid-claim", async () => {
    vi.mocked(sessionRepo.claimNextForServerFallback)
      .mockResolvedValueOnce(makeSession({ id: "sess_orphan" }))
      .mockResolvedValueOnce(makeSession({ id: "sess_ok" }))
      .mockResolvedValue(undefined);
    vi.mocked(agentRepo.findById)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(makeAgent());

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    await flush();

    expect(sessionRepo.update).toHaveBeenCalledWith("sess_orphan", {
      status: "failed",
      error: "agent_missing_at_claim",
      completed_at: expect.any(Date),
    });
    // The loop kept going and dispatched the healthy session behind it.
    expect(dispatchTask).toHaveBeenCalledOnce();
    expect(dispatchTask.mock.calls[0]![0]).toMatchObject({ id: "sess_ok" });
    await worker.stop();
  });

  it("flips the task into its active status at claim time", async () => {
    vi.mocked(sessionRepo.claimNextForServerFallback)
      .mockResolvedValueOnce(makeSession({ id: "sess_1", task_id: "task_1" }))
      .mockResolvedValue(undefined);
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ id: "task_1", status: "assigned" }),
    );

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    await flush();

    expect(taskRepo.update).toHaveBeenCalledWith("task_1", { status: "in_progress" });
    await worker.stop();
  });

  it("does not transition the task for a chat session", async () => {
    vi.mocked(sessionRepo.claimNextForServerFallback)
      .mockResolvedValueOnce(
        makeSession({ id: "sess_chat", type: "chat", task_id: undefined }),
      )
      .mockResolvedValue(undefined);

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    await flush();

    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(dispatchTask).toHaveBeenCalledOnce();
    await worker.stop();
  });

  it("clears the in-flight entry after a dispatch settles", async () => {
    vi.mocked(sessionRepo.claimNextForServerFallback)
      .mockResolvedValueOnce(makeSession({ id: "sess_1", task_id: undefined }))
      .mockResolvedValue(undefined);

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    await flush();

    expect(worker.status().inFlightCount).toBe(0);
    expect(onError).not.toHaveBeenCalled();
    await worker.stop();
  });

  it("surfaces a dispatch rejection via onError and still clears in-flight", async () => {
    const boom = new Error("cli spawn failed");
    dispatchTask.mockRejectedValue(boom);
    vi.mocked(sessionRepo.claimNextForServerFallback)
      .mockResolvedValueOnce(makeSession({ id: "sess_1", task_id: undefined }))
      .mockResolvedValue(undefined);

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    await flush();

    expect(onError).toHaveBeenCalledWith(boom);
    expect(worker.status().inFlightCount).toBe(0);
    await worker.stop();
  });

  it("wraps a non-Error dispatch rejection before handing it to onError", async () => {
    dispatchTask.mockRejectedValue("just a string");
    vi.mocked(sessionRepo.claimNextForServerFallback)
      .mockResolvedValueOnce(makeSession({ id: "sess_1", task_id: undefined }))
      .mockResolvedValue(undefined);

    const worker = makeWorker({ pollIntervalMs: 60_000 });
    await worker.start();
    await flush();

    expect(onError).toHaveBeenCalledOnce();
    const err = onError.mock.calls[0]![0] as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("just a string");
    await worker.stop();
  });

  it("defaults onError to console.error when the caller supplies none", async () => {
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("cli spawn failed");
    dispatchTask.mockRejectedValue(boom);
    vi.mocked(sessionRepo.claimNextForServerFallback)
      .mockResolvedValueOnce(makeSession({ id: "sess_1", task_id: undefined }))
      .mockResolvedValue(undefined);

    const worker = new TaskExecutionWorker({
      agentRepo,
      taskRepo,
      sessionRepo,
      workspaceManager,
      dispatchTask: dispatchTask as unknown as DispatchFn,
      pollIntervalMs: 60_000,
    });
    await worker.start();
    await flush();

    expect(consoleErr).toHaveBeenCalledWith("[worker] dispatch error:", boom);
    await worker.stop();
  });

  it("stops draining the claim queue once the worker is stopped mid-loop", async () => {
    const worker = makeWorker({ pollIntervalMs: 60_000 });
    // Stopping from inside the first claim proves the `while (this.running)`
    // guard is re-checked per iteration rather than only on entry.
    vi.mocked(sessionRepo.claimNextForServerFallback).mockImplementation(async () => {
      await worker.stop();
      return makeSession({ id: "sess_1", task_id: undefined });
    });

    await worker.start();
    await flush();

    expect(sessionRepo.claimNextForServerFallback).toHaveBeenCalledTimes(1);
    expect(dispatchTask).toHaveBeenCalledOnce();
  });
});
