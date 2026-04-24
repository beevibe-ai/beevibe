import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStatus } from "../domain/task.js";
import type { WorkProduct } from "../domain/work-product.js";
import type { TaskRepository } from "../ports/task-repo.js";
import type { WorkProductRepository } from "../ports/work-product-repo.js";
import {
  InvalidTaskTransitionError,
  TaskNotFoundError,
  TaskService,
} from "./task-service.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    title: "Do the thing",
    status: "in_progress",
    priority: "medium",
    creator_id: "person_1",
    creator_type: "person",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeWorkProduct(overrides: Partial<WorkProduct> = {}): WorkProduct {
  return {
    id: "wp_1",
    task_id: "task_1",
    agent_id: "agent_1",
    type: "pull_request",
    title: "PR #42",
    created_at: new Date(),
    ...overrides,
  };
}

let taskRepo: TaskRepository;
let workProductRepo: WorkProductRepository;
let service: TaskService;

beforeEach(() => {
  taskRepo = {
    findById: vi.fn(),
    list: vi.fn(),
    listByAssignee: vi.fn(),
    listReviewQueue: vi.fn(),
    countChildrenNotComplete: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateProgress: vi.fn(),
    markBlocked: vi.fn(),
    clearBlocker: vi.fn(),
    delete: vi.fn(),
  };
  workProductRepo = {
    findById: vi.fn(),
    listByTask: vi.fn(),
    listByAgent: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };
  service = new TaskService({ taskRepo, workProductRepo });
});

describe("TaskService.updateProgress", () => {
  it("delegates to taskRepo.updateProgress when the task exists", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask());
    vi.mocked(taskRepo.updateProgress).mockImplementation(async (id, status, summary) =>
      makeTask({ id, status, result_summary: summary }),
    );

    const out = await service.updateProgress("task_1", "review", "Ready for review");
    expect(out.status).toBe("review");
    expect(out.result_summary).toBe("Ready for review");
    expect(taskRepo.updateProgress).toHaveBeenCalledWith(
      "task_1",
      "review",
      "Ready for review",
    );
  });

  it("throws TaskNotFoundError when the task is missing", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(undefined);
    await expect(
      service.updateProgress("task_x", "in_progress", "x"),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });
});

describe("TaskService.markBlocked + clearBlocker", () => {
  it("markBlocked delegates with blocker + reason", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask());
    vi.mocked(taskRepo.markBlocked).mockImplementation(async (id, by, reason) =>
      makeTask({ id, status: "blocked", blocker_agent_id: by, blocker_reason: reason }),
    );
    const out = await service.markBlocked("task_1", "agent_2", "waiting on infra");
    expect(out.status).toBe("blocked");
    expect(out.blocker_agent_id).toBe("agent_2");
    expect(out.blocker_reason).toBe("waiting on infra");
  });

  it("clearBlocker delegates and task returns to in_progress via repo", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "blocked" }));
    vi.mocked(taskRepo.clearBlocker).mockImplementation(async (id) =>
      makeTask({ id, status: "in_progress" }),
    );
    const out = await service.clearBlocker("task_1");
    expect(out.status).toBe("in_progress");
  });
});

describe("TaskService.approveTask", () => {
  it.each([
    ["approve", "done"],
    ["reject", "cancelled"],
    ["revise", "needs_revision"],
  ] as const)(
    "transitions review → %s via %s",
    async (action, expectedStatus) => {
      vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "review" }));
      vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
        makeTask({ id, ...patch, status: patch.status ?? "review" }),
      );
      const out = await service.approveTask("task_1", action, "wrapping up");
      expect(out.status).toBe(expectedStatus as TaskStatus);
      expect(taskRepo.update).toHaveBeenCalledWith("task_1", {
        status: expectedStatus,
        result_summary: "wrapping up",
      });
    },
  );

  it("allows approving from 'needs_revision' too (reviewer changes mind before executor picks up re-work)", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "needs_revision" }));
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? "needs_revision" }),
    );
    const out = await service.approveTask("task_1", "approve");
    expect(out.status).toBe("done");
  });

  it("rejects approval from 'revision' (actively running re-work — can't approve mid-run)", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "revision" }));
    await expect(
      service.approveTask("task_1", "approve"),
    ).rejects.toBeInstanceOf(InvalidTaskTransitionError);
  });

  it("rejects approval from an invalid status", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "in_progress" }));
    await expect(
      service.approveTask("task_1", "approve"),
    ).rejects.toBeInstanceOf(InvalidTaskTransitionError);
  });

  it("preserves existing result_summary when none is passed", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ status: "review", result_summary: "already done" }),
    );
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? "review" }),
    );
    await service.approveTask("task_1", "approve");
    expect(taskRepo.update).toHaveBeenCalledWith("task_1", {
      status: "done",
      result_summary: "already done",
    });
  });
});

describe("TaskService.cancelTask", () => {
  it("cancels a non-terminal task", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "in_progress" }));
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? "in_progress" }),
    );
    const out = await service.cancelTask("task_1", { reason: "scope change" });
    expect(out.status).toBe("cancelled");
    expect(taskRepo.update).toHaveBeenCalledWith("task_1", {
      status: "cancelled",
      result_summary: "scope change",
    });
  });

  it("rejects cancelling an already-done task without force", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "done" }));
    await expect(service.cancelTask("task_1")).rejects.toBeInstanceOf(
      InvalidTaskTransitionError,
    );
  });

  it("allows cancelling a terminal task with force=true", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "done" }));
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? "done" }),
    );
    const out = await service.cancelTask("task_1", { force: true });
    expect(out.status).toBe("cancelled");
  });
});

describe("TaskService.createWorkProduct + listWorkProducts", () => {
  it("createWorkProduct verifies task exists then delegates", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask());
    vi.mocked(workProductRepo.create).mockResolvedValue(makeWorkProduct());
    const out = await service.createWorkProduct({
      id: "wp_1",
      task_id: "task_1",
      agent_id: "agent_1",
      type: "pull_request",
      title: "PR #42",
    });
    expect(out.id).toBe("wp_1");
    expect(workProductRepo.create).toHaveBeenCalled();
  });

  it("createWorkProduct throws when the task is missing", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(undefined);
    await expect(
      service.createWorkProduct({
        id: "wp_x",
        task_id: "task_missing",
        agent_id: "agent_1",
        type: "pull_request",
        title: "PR",
      }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(workProductRepo.create).not.toHaveBeenCalled();
  });

  it("listWorkProducts delegates to the repo", async () => {
    vi.mocked(workProductRepo.listByTask).mockResolvedValue([makeWorkProduct()]);
    const out = await service.listWorkProducts("task_1");
    expect(out).toHaveLength(1);
    expect(workProductRepo.listByTask).toHaveBeenCalledWith("task_1");
  });
});

describe("TaskService.checkAndCompleteParent", () => {
  it("completes the parent when all siblings are done", async () => {
    vi.mocked(taskRepo.findById)
      .mockResolvedValueOnce(makeTask({ id: "task_child", parent_task_id: "task_parent" }))
      .mockResolvedValueOnce(makeTask({ id: "task_parent", status: "in_progress" }));
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(0);
    vi.mocked(taskRepo.updateProgress).mockImplementation(async (id, status, summary) =>
      makeTask({ id, status, result_summary: summary }),
    );

    await service.checkAndCompleteParent("task_child");
    expect(taskRepo.updateProgress).toHaveBeenCalledWith(
      "task_parent",
      "done",
      expect.stringContaining("subtasks completed"),
    );
  });

  it("does nothing when siblings are still open", async () => {
    vi.mocked(taskRepo.findById)
      .mockResolvedValueOnce(makeTask({ parent_task_id: "task_parent" }))
      .mockResolvedValueOnce(makeTask({ id: "task_parent", status: "in_progress" }));
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(2);

    await service.checkAndCompleteParent("task_child");
    expect(taskRepo.updateProgress).not.toHaveBeenCalled();
  });

  it("does nothing when the task has no parent", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ parent_task_id: undefined }));
    await service.checkAndCompleteParent("task_solo");
    expect(taskRepo.countChildrenNotComplete).not.toHaveBeenCalled();
    expect(taskRepo.updateProgress).not.toHaveBeenCalled();
  });

  it("does nothing when the parent is already complete (idempotent on re-entry)", async () => {
    vi.mocked(taskRepo.findById)
      .mockResolvedValueOnce(makeTask({ parent_task_id: "task_parent" }))
      .mockResolvedValueOnce(makeTask({ id: "task_parent", status: "done" }));
    await service.checkAndCompleteParent("task_child");
    expect(taskRepo.countChildrenNotComplete).not.toHaveBeenCalled();
    expect(taskRepo.updateProgress).not.toHaveBeenCalled();
  });

  it("preserves parent's existing result_summary when rolling up", async () => {
    vi.mocked(taskRepo.findById)
      .mockResolvedValueOnce(makeTask({ parent_task_id: "task_parent" }))
      .mockResolvedValueOnce(
        makeTask({
          id: "task_parent",
          status: "in_progress",
          result_summary: "parent says hi",
        }),
      );
    vi.mocked(taskRepo.countChildrenNotComplete).mockResolvedValue(0);
    vi.mocked(taskRepo.updateProgress).mockImplementation(async (id, status, summary) =>
      makeTask({ id, status, result_summary: summary }),
    );
    await service.checkAndCompleteParent("task_child");
    expect(taskRepo.updateProgress).toHaveBeenCalledWith(
      "task_parent",
      "done",
      "parent says hi",
    );
  });
});
