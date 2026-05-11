import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../domain/session.js";
import type { Task } from "../domain/task.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type { TaskRepository } from "../ports/task-repo.js";
import type { DispatchService } from "./dispatch-service.js";
import { DaemonOrphanReaper } from "./orphan-reaper.js";

const FIXED_NOW = new Date("2026-05-09T00:00:00Z");

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_orphan",
    agent_id: "agent_a",
    task_id: "task_t",
    type: "task",
    status: "running",
    intent: "do",
    created_at: FIXED_NOW,
    runtime_id: "rt_dead",
    ...overrides,
  };
}

function fakeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_t",
    title: "Do thing",
    status: "in_progress",
    priority: "medium",
    creator_id: "person_owner",
    creator_type: "person",
    assignee_id: "agent_a",
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    ...overrides,
  };
}

let sessionRepo: SessionRepository;
let taskRepo: TaskRepository;
let dispatchService: DispatchService;
let onSessionReaped: ReturnType<typeof vi.fn>;
let reaper: DaemonOrphanReaper;

beforeEach(() => {
  sessionRepo = {
    findById: vi.fn(),
    findLatestForTask: vi.fn(),
    listForTask: vi.fn(),
    listForAgent: vi.fn(),
    listChatForAgent: vi.fn(),
    countRunningByAgent: vi.fn(),
    listRunningWithPid: vi.fn(),
    listDaemonOrphaned: vi.fn(async () => []),
    claimNextForRuntime: vi.fn(),
    claimNextForServerFallback: vi.fn(),
    countOwnedByDaemon: vi.fn(),
    findLatestForAgentInRoom: vi.fn(),
    listRunningInRoom: vi.fn(),
    create: vi.fn(),
    update: vi.fn(async (id, patch) => fakeSession({ id, ...(patch as Partial<Session>) })),
  } as unknown as SessionRepository;
  taskRepo = {
    findById: vi.fn(async () => fakeTask()),
    update: vi.fn(),
  } as unknown as TaskRepository;
  dispatchService = {
    dispatchTask: vi.fn(async () => ({
      session: fakeSession({ id: "sess_recovery" }),
      runtime_id: "rt_dead",
    })),
  } as unknown as DispatchService;
  onSessionReaped = vi.fn();
  reaper = new DaemonOrphanReaper({
    sessionRepo,
    taskRepo,
    dispatchService,
    onSessionReaped,
  });
});

describe("DaemonOrphanReaper.tick", () => {
  it("returns 0/0 when nothing is orphaned", async () => {
    const result = await reaper.tick();
    expect(result).toEqual({ reaped: 0, redispatched: 0 });
  });

  it("marks orphan failed with error='daemon_orphaned'", async () => {
    vi.mocked(sessionRepo.listDaemonOrphaned).mockResolvedValue([fakeSession()]);

    await reaper.tick();

    expect(sessionRepo.update).toHaveBeenCalledWith(
      "sess_orphan",
      expect.objectContaining({ status: "failed", error: "daemon_orphaned" }),
    );
  });

  it("re-dispatches a task orphan with crash_recovery + prior_session_id pin", async () => {
    vi.mocked(sessionRepo.listDaemonOrphaned).mockResolvedValue([fakeSession()]);

    const result = await reaper.tick();

    expect(result.reaped).toBe(1);
    expect(result.redispatched).toBe(1);
    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent_a",
        type: "task",
        reason: { kind: "crash_recovery", prior_session_id: "sess_orphan" },
      }),
    );
    expect(taskRepo.update).toHaveBeenCalledWith("task_t", { status: "assigned" });
  });

  it("re-queues revision tasks back to needs_revision", async () => {
    vi.mocked(sessionRepo.listDaemonOrphaned).mockResolvedValue([fakeSession()]);
    vi.mocked(taskRepo.findById).mockResolvedValue(fakeTask({ status: "revision" }));

    await reaper.tick();

    expect(taskRepo.update).toHaveBeenCalledWith("task_t", { status: "needs_revision" });
  });

  it("does NOT re-dispatch chat orphans", async () => {
    vi.mocked(sessionRepo.listDaemonOrphaned).mockResolvedValue([
      fakeSession({ type: "chat", task_id: undefined }),
    ]);

    const result = await reaper.tick();

    expect(result.reaped).toBe(1);
    expect(result.redispatched).toBe(0);
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("fires onSessionReaped with the just-failed session", async () => {
    vi.mocked(sessionRepo.listDaemonOrphaned).mockResolvedValue([
      fakeSession({ type: "chat", task_id: undefined }),
    ]);

    await reaper.tick();

    expect(onSessionReaped).toHaveBeenCalledOnce();
    const arg = onSessionReaped.mock.calls[0]![0] as Session;
    expect(arg.status).toBe("failed");
    expect(arg.error).toBe("daemon_orphaned");
  });

  it("swallows onSessionReaped errors (best-effort hook)", async () => {
    vi.mocked(sessionRepo.listDaemonOrphaned).mockResolvedValue([fakeSession()]);
    onSessionReaped.mockRejectedValue(new Error("hub down"));
    const onError = vi.fn();
    reaper = new DaemonOrphanReaper({
      sessionRepo,
      taskRepo,
      dispatchService,
      onSessionReaped,
      onError,
    });

    const result = await reaper.tick();

    expect(result.reaped).toBe(1);
    expect(onError).toHaveBeenCalled();
  });

  it("does not re-dispatch when task has no assignee", async () => {
    vi.mocked(sessionRepo.listDaemonOrphaned).mockResolvedValue([fakeSession()]);
    vi.mocked(taskRepo.findById).mockResolvedValue(
      fakeTask({ assignee_id: undefined }),
    );

    const result = await reaper.tick();

    expect(result.reaped).toBe(1);
    expect(result.redispatched).toBe(0);
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("uses configured stale thresholds when querying", async () => {
    reaper = new DaemonOrphanReaper({
      sessionRepo,
      taskRepo,
      dispatchService,
      onSessionReaped,
      sessionStaleSeconds: 30,
      runtimeHeartbeatStaleSeconds: 10,
    });

    await reaper.tick();

    expect(sessionRepo.listDaemonOrphaned).toHaveBeenCalledWith({
      sessionStaleSeconds: 30,
      runtimeHeartbeatStaleSeconds: 10,
    });
  });
});
