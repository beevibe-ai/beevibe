import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Session,
  SessionRepository,
  Task,
  TaskRepository,
  Workspace,
} from "@beevibe/core";
import type { AgentSession } from "@beevibe/core/services/agent-session";
import type { TaskService } from "@beevibe/core/services/task-service";
import {
  NUDGE_COMPLETION_MARKER,
  postDispatchCheck,
} from "./post-dispatch.js";

const WORKSPACE: Workspace = { path: "/tmp/ws" };

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_t",
    title: "Do thing",
    status: "in_progress",
    priority: "medium",
    creator_id: "person_owner",
    creator_type: "person",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_orig",
    agent_id: "agent_a",
    type: "task",
    status: "succeeded",
    intent: '<task id="task_t">\nDo thing\n</task>',
    task_id: "task_t",
    created_at: new Date(),
    ...overrides,
  } as Session;
}

let taskRepo: TaskRepository;
let taskService: TaskService;
let agentSession: AgentSession;
let sessionRepo: SessionRepository;

beforeEach(() => {
  vi.useFakeTimers();
  taskRepo = {
    findById: vi.fn(),
    list: vi.fn(),
    listByAssignee: vi.fn(),
    listAssignable: vi.fn(),
    claimById: vi.fn(),
    listReviewQueue: vi.fn(),
    countChildrenNotComplete: vi.fn(),
    countChildren: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateProgress: vi.fn(),
    markBlocked: vi.fn(),
    clearBlocker: vi.fn(),
    delete: vi.fn(),
  };
  taskService = {
    checkAndCompleteParent: vi.fn(),
  } as unknown as TaskService;
  agentSession = {
    run: vi.fn(),
  } as unknown as AgentSession;
  sessionRepo = {
    findById: vi.fn(),
    findLatestForTask: vi.fn(),
    listForTask: vi.fn(),
    listForAgent: vi.fn(),
    countRunningByAgent: vi.fn(),
    listRunningWithPid: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  // Default: the session under check IS the latest. Override per-test for
  // the stale-dispatch scenario.
  vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue({
    id: "sess_orig",
  } as unknown as Session);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Drive the 2_000ms grace timer + the awaited downstream chain.
 * `vi.advanceTimersByTimeAsync` runs queued microtasks between ticks so
 * `findById` etc. resolve before the next assertion.
 */
async function advanceGrace(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2_000);
}

describe("postDispatchCheck", () => {
  it("agent set terminal status → calls checkAndCompleteParent and returns", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ status: "done" }),
    );

    const promise = postDispatchCheck(
      { taskRepo, taskService, agentSession, sessionRepo },
      "task_t",
      "agent_a",
      WORKSPACE,
      makeSession(),
    );
    await advanceGrace();
    await promise;

    expect(taskService.checkAndCompleteParent).toHaveBeenCalledWith("task_t");
    expect(taskRepo.countChildrenNotComplete).not.toHaveBeenCalled();
    expect(agentSession.run).not.toHaveBeenCalled();
  });

  it("task deleted between session-end and grace-window → no-op", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(undefined);

    const promise = postDispatchCheck(
      { taskRepo, taskService, agentSession, sessionRepo },
      "task_t",
      "agent_a",
      WORKSPACE,
      makeSession(),
    );
    await advanceGrace();
    await promise;

    expect(taskService.checkAndCompleteParent).not.toHaveBeenCalled();
    expect(agentSession.run).not.toHaveBeenCalled();
  });

  it("still in_progress with non-terminal children → no-op (parent waiting on children)", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ status: "in_progress" }),
    );
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(2);

    const promise = postDispatchCheck(
      { taskRepo, taskService, agentSession, sessionRepo },
      "task_t",
      "agent_a",
      WORKSPACE,
      makeSession(),
    );
    await advanceGrace();
    await promise;

    expect(taskRepo.countChildrenNotComplete).toHaveBeenCalledWith("task_t");
    // childNotComplete > 0 → no retry / no rollup; both child counts fire
    // in parallel so countChildren is also called (cheap), but neither
    // downstream side-effect runs.
    expect(agentSession.run).not.toHaveBeenCalled();
    expect(taskService.checkAndCompleteParent).not.toHaveBeenCalled();
  });

  it("still in_progress with all-terminal children → log warning + checkAndCompleteParent (mixed-outcome rollup)", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ status: "in_progress" }),
    );
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(0);
    vi.mocked(taskRepo.countChildren).mockResolvedValue(3);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const promise = postDispatchCheck(
      { taskRepo, taskService, agentSession, sessionRepo },
      "task_t",
      "agent_a",
      WORKSPACE,
      makeSession(),
    );
    await advanceGrace();
    await promise;

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[post-dispatch] parent task_t has 3 all-terminal children",
      ),
    );
    expect(taskService.checkAndCompleteParent).toHaveBeenCalledWith("task_t");
    expect(agentSession.run).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("leaf, agent forgot update_progress → retry once with nudge intent and skipOnComplete=true", async () => {
    vi.mocked(taskRepo.findById)
      .mockResolvedValueOnce(makeTask({ status: "in_progress" })) // initial check
      .mockResolvedValueOnce(makeTask({ status: "done" })); // after retry
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(0);
    vi.mocked(taskRepo.countChildren).mockResolvedValue(0);
    vi.mocked(agentSession.run).mockResolvedValue({
      id: "sess_retry",
      agent_id: "agent_a",
      type: "task",
      status: "succeeded",
      intent: "x",
      created_at: new Date(),
    } as unknown as Session);

    const promise = postDispatchCheck(
      { taskRepo, taskService, agentSession, sessionRepo },
      "task_t",
      "agent_a",
      WORKSPACE,
      makeSession({ id: "sess_orig" }),
    );
    await advanceGrace();
    await promise;

    expect(agentSession.run).toHaveBeenCalledTimes(1);
    const runArg = vi.mocked(agentSession.run).mock.calls[0]![0];
    expect(runArg.agentId).toBe("agent_a");
    expect(runArg.taskId).toBe("task_t");
    expect(runArg.priorSessionId).toBe("sess_orig");
    expect(runArg.skipOnComplete).toBe(true);
    expect(runArg.intent).toContain(NUDGE_COMPLETION_MARKER);
    expect(runArg.intent).toContain('<task id="task_t"/>');
    // Retry succeeded → status now terminal → no failed update.
    expect(taskRepo.update).not.toHaveBeenCalled();
  });

  it("retry also exits without setting terminal status → mark task failed", async () => {
    vi.mocked(taskRepo.findById)
      .mockResolvedValueOnce(makeTask({ status: "in_progress" })) // initial
      .mockResolvedValueOnce(makeTask({ status: "in_progress" })); // after retry
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(0);
    vi.mocked(taskRepo.countChildren).mockResolvedValue(0);
    vi.mocked(agentSession.run).mockResolvedValue({
      id: "sess_retry",
      agent_id: "agent_a",
      type: "task",
      status: "succeeded",
      intent: "x",
      created_at: new Date(),
    } as unknown as Session);

    const promise = postDispatchCheck(
      { taskRepo, taskService, agentSession, sessionRepo },
      "task_t",
      "agent_a",
      WORKSPACE,
      makeSession(),
    );
    await advanceGrace();
    await promise;

    expect(taskRepo.update).toHaveBeenCalledWith("task_t", {
      status: "failed",
      result_summary: expect.stringContaining(
        "Two consecutive sessions exited without calling update_progress",
      ),
    });
  });

  it("stale-dispatch guard: newer session for same task → skip retry (avoids racing the worker's re-dispatch)", async () => {
    // Scenario: first session terminates, e2e (or a human) flips task to
    // needs_revision, worker picks it up and dispatches a second session
    // before this post-dispatch wakes from its grace sleep. By the time
    // we check, findLatestForTask returns the SECOND session — this
    // post-dispatch is stale and must not retry.
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ status: "revision" }),
    );
    vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue({
      id: "sess_newer",
    } as unknown as Session);

    const promise = postDispatchCheck(
      { taskRepo, taskService, agentSession, sessionRepo },
      "task_t",
      "agent_a",
      WORKSPACE,
      makeSession({ id: "sess_orig" }),
    );
    await advanceGrace();
    await promise;

    expect(agentSession.run).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(taskRepo.countChildrenNotComplete).not.toHaveBeenCalled();
  });

  it("revision-status leaf gets retried just like in_progress (running statuses are equivalent for the gate)", async () => {
    vi.mocked(taskRepo.findById)
      .mockResolvedValueOnce(makeTask({ status: "revision" }))
      .mockResolvedValueOnce(makeTask({ status: "done" }));
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(0);
    vi.mocked(taskRepo.countChildren).mockResolvedValue(0);
    vi.mocked(agentSession.run).mockResolvedValue({
      id: "sess_retry",
      agent_id: "agent_a",
      type: "task",
      status: "succeeded",
      intent: "x",
      created_at: new Date(),
    } as unknown as Session);

    const promise = postDispatchCheck(
      { taskRepo, taskService, agentSession, sessionRepo },
      "task_t",
      "agent_a",
      WORKSPACE,
      makeSession(),
    );
    await advanceGrace();
    await promise;

    expect(agentSession.run).toHaveBeenCalledTimes(1);
  });
});
