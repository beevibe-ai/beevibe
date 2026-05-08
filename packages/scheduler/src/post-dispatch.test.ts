import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Session,
  SessionRepository,
  Task,
  TaskRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { TaskService } from "@beevibe/core/services/task-service";
import {
  NUDGE_COMPLETION_MARKER,
  postDispatchCheck,
} from "./post-dispatch.js";

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
let dispatchService: DispatchService;
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
  dispatchService = {
    dispatchTask: vi.fn().mockResolvedValue({
      session: makeSession({ id: "sess_retry" }),
      runtime_id: null,
    }),
  } as unknown as DispatchService;
  sessionRepo = {
    findById: vi.fn(),
    findLatestForTask: vi.fn(),
    listForTask: vi.fn(),
    listForAgent: vi.fn(),
    countRunningByAgent: vi.fn(),
    listRunningWithPid: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  } as unknown as SessionRepository;
  vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue({
    id: "sess_orig",
  } as unknown as Session);
});

afterEach(() => {
  vi.useRealTimers();
});

const GRACE_MS = 2_000;
const RETRY_WAIT_MS = GRACE_MS * 30;

async function advanceGrace(): Promise<void> {
  await vi.advanceTimersByTimeAsync(GRACE_MS);
}

async function advanceRetryWait(): Promise<void> {
  await vi.advanceTimersByTimeAsync(RETRY_WAIT_MS);
}

describe("postDispatchCheck (Phase 4 — dispatchService retry)", () => {
  it("agent set terminal status → calls checkAndCompleteParent and returns", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "done" }));

    const p = postDispatchCheck(
      { taskRepo, taskService, dispatchService, sessionRepo },
      "task_t",
      "agent_a",
      makeSession(),
    );
    await advanceGrace();
    await p;

    expect(taskService.checkAndCompleteParent).toHaveBeenCalledWith("task_t");
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("task deleted before grace → no-op", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(undefined);

    const p = postDispatchCheck(
      { taskRepo, taskService, dispatchService, sessionRepo },
      "task_t",
      "agent_a",
      makeSession(),
    );
    await advanceGrace();
    await p;

    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
    expect(taskService.checkAndCompleteParent).not.toHaveBeenCalled();
  });

  it("still in_progress with non-terminal children → no-op", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ status: "in_progress" }),
    );
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(2);

    const p = postDispatchCheck(
      { taskRepo, taskService, dispatchService, sessionRepo },
      "task_t",
      "agent_a",
      makeSession(),
    );
    await advanceGrace();
    await p;

    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
    expect(taskService.checkAndCompleteParent).not.toHaveBeenCalled();
  });

  it("still in_progress with all-terminal children → log warning + checkAndCompleteParent", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ status: "in_progress" }),
    );
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(0);
    vi.mocked(taskRepo.countChildren).mockResolvedValue(3);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const p = postDispatchCheck(
      { taskRepo, taskService, dispatchService, sessionRepo },
      "task_t",
      "agent_a",
      makeSession(),
    );
    await advanceGrace();
    await p;

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[post-dispatch] parent task_t has 3 all-terminal children",
      ),
    );
    expect(taskService.checkAndCompleteParent).toHaveBeenCalledWith("task_t");
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("leaf, agent forgot update_progress → dispatch crash_recovery retry pinned to prior session", async () => {
    vi.mocked(taskRepo.findById)
      .mockResolvedValueOnce(makeTask({ status: "in_progress" })) // initial check
      .mockResolvedValueOnce(makeTask({ status: "done" })); // after retry settles
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(0);
    vi.mocked(taskRepo.countChildren).mockResolvedValue(0);

    const p = postDispatchCheck(
      { taskRepo, taskService, dispatchService, sessionRepo },
      "task_t",
      "agent_a",
      makeSession({ id: "sess_orig" }),
    );
    await advanceGrace();
    await advanceRetryWait();
    await p;

    expect(dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(dispatchService.dispatchTask).mock.calls[0]![0];
    expect(arg.agentId).toBe("agent_a");
    expect(arg.task?.id).toBe("task_t");
    expect(arg.type).toBe("task");
    expect(arg.intent).toContain(NUDGE_COMPLETION_MARKER);
    expect(arg.intent).toContain('<task id="task_t"/>');
    expect(arg.reason.kind).toBe("crash_recovery");
    expect(
      arg.reason.kind === "crash_recovery" ? arg.reason.prior_session_id : undefined,
    ).toBe("sess_orig");
    // Retry settled to terminal status → no failed update.
    expect(taskRepo.update).not.toHaveBeenCalled();
  });

  it("retry also exits without terminal status → mark task failed", async () => {
    vi.mocked(taskRepo.findById)
      .mockResolvedValueOnce(makeTask({ status: "in_progress" })) // initial
      .mockResolvedValueOnce(makeTask({ status: "in_progress" })); // after retry
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(0);
    vi.mocked(taskRepo.countChildren).mockResolvedValue(0);

    const p = postDispatchCheck(
      { taskRepo, taskService, dispatchService, sessionRepo },
      "task_t",
      "agent_a",
      makeSession(),
    );
    await advanceGrace();
    await advanceRetryWait();
    await p;

    expect(taskRepo.update).toHaveBeenCalledWith("task_t", {
      status: "failed",
      result_summary: expect.stringContaining(
        "Two consecutive sessions exited without calling update_progress",
      ),
    });
  });

  it("stale-dispatch guard: newer session for same task → skip retry", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ status: "revision" }),
    );
    vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue({
      id: "sess_newer",
    } as unknown as Session);

    const p = postDispatchCheck(
      { taskRepo, taskService, dispatchService, sessionRepo },
      "task_t",
      "agent_a",
      makeSession({ id: "sess_orig" }),
    );
    await advanceGrace();
    await p;

    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(taskRepo.countChildrenNotComplete).not.toHaveBeenCalled();
  });

  it("revision-status leaf gets retried just like in_progress", async () => {
    vi.mocked(taskRepo.findById)
      .mockResolvedValueOnce(makeTask({ status: "revision" }))
      .mockResolvedValueOnce(makeTask({ status: "done" }));
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(0);
    vi.mocked(taskRepo.countChildren).mockResolvedValue(0);

    const p = postDispatchCheck(
      { taskRepo, taskService, dispatchService, sessionRepo },
      "task_t",
      "agent_a",
      makeSession(),
    );
    await advanceGrace();
    await advanceRetryWait();
    await p;

    expect(dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
  });
});
