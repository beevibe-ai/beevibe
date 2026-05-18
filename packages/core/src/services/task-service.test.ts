import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, ReviewPolicy } from "../domain/agent.js";
import type { Task } from "../domain/task.js";
import type { WorkProduct, WorkProductListItem } from "../domain/work-product.js";
import type { Session } from "../domain/session.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { SessionRepository } from "../ports/session-repo.js";
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
    updated_at: new Date(),
    ...overrides,
  };
}

function makeWorkProductListItem(
  overrides: Partial<WorkProductListItem> = {},
): WorkProductListItem {
  const { body: _body, ...rest } = makeWorkProduct();
  return { ...rest, body_bytes: 0, ...overrides };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_prior",
    agent_id: "agent_1",
    type: "task",
    status: "succeeded",
    intent: "test",
    cli_session_id: "cli_abc",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeAgent(review_policy?: ReviewPolicy): Agent {
  return {
    id: "agent_1",
    name: "A",
    owner_id: "person_1",
    hierarchy_level: "ic",
    runtime_config: { type: "claude" },
    review_policy,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

let taskRepo: TaskRepository;
let workProductRepo: WorkProductRepository;
let agentRepo: AgentRepository;
let sessionRepo: SessionRepository;
let service: TaskService;

beforeEach(() => {
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
  workProductRepo = {
    findById: vi.fn(),
    listByTask: vi.fn(),
    listByAgent: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  agentRepo = {
    findById: vi.fn(),
    findByApiKey: vi.fn(),
    findByOwnerId: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findParent: vi.fn(),
    findByLevel: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  sessionRepo = {
    findById: vi.fn(),
    findLatestForTask: vi.fn(async () => undefined),
    listForTask: vi.fn(),
    listForAgent: vi.fn(),
    countRunningByAgent: vi.fn(),
    listRunningWithPid: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  service = new TaskService({ taskRepo, workProductRepo, agentRepo, sessionRepo });
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

  describe("review_policy gating", () => {
    it("agent.review_policy='require_human' + status='done' → transitions to 'review'", async () => {
      vi.mocked(taskRepo.findById).mockResolvedValue(
        makeTask({ assignee_id: "agent_1" }),
      );
      vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent("require_human"));
      vi.mocked(taskRepo.updateProgress).mockImplementation(async (id, status, summary) =>
        makeTask({ id, status, result_summary: summary }),
      );

      const out = await service.updateProgress("task_1", "done", "finished it");
      expect(out.status).toBe("review");
      // Critical: the REPO is called with "review", not "done" — the gate
      // rewrites the status before persisting.
      expect(taskRepo.updateProgress).toHaveBeenCalledWith("task_1", "review", "finished it");
    });

    it("agent.review_policy='auto_done' + status='done' → passes through as 'done'", async () => {
      vi.mocked(taskRepo.findById).mockResolvedValue(
        makeTask({ assignee_id: "agent_1" }),
      );
      vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent("auto_done"));
      vi.mocked(taskRepo.updateProgress).mockImplementation(async (id, status, summary) =>
        makeTask({ id, status, result_summary: summary }),
      );

      const out = await service.updateProgress("task_1", "done", "finished it");
      expect(out.status).toBe("done");
      expect(taskRepo.updateProgress).toHaveBeenCalledWith("task_1", "done", "finished it");
    });

    it("agent.review_policy=undefined + status='done' → passes through as 'done' (default is auto_done)", async () => {
      vi.mocked(taskRepo.findById).mockResolvedValue(
        makeTask({ assignee_id: "agent_1" }),
      );
      vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent(undefined));
      vi.mocked(taskRepo.updateProgress).mockImplementation(async (id, status, summary) =>
        makeTask({ id, status, result_summary: summary }),
      );

      const out = await service.updateProgress("task_1", "done", "finished it");
      expect(out.status).toBe("done");
    });

    it("agent.review_policy='require_human' + status='failed' → NOT gated (failed stays failed)", async () => {
      vi.mocked(taskRepo.findById).mockResolvedValue(
        makeTask({ assignee_id: "agent_1" }),
      );
      vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent("require_human"));
      vi.mocked(taskRepo.updateProgress).mockImplementation(async (id, status, summary) =>
        makeTask({ id, status, result_summary: summary }),
      );

      const out = await service.updateProgress("task_1", "failed", "it broke");
      expect(out.status).toBe("failed");
    });

    it("agent.review_policy='require_human' + status='blocked' → NOT gated", async () => {
      vi.mocked(taskRepo.findById).mockResolvedValue(
        makeTask({ assignee_id: "agent_1" }),
      );
      vi.mocked(agentRepo.findById).mockResolvedValue(makeAgent("require_human"));
      vi.mocked(taskRepo.updateProgress).mockImplementation(async (id, status, summary) =>
        makeTask({ id, status, result_summary: summary }),
      );

      const out = await service.updateProgress("task_1", "blocked", "waiting on x");
      expect(out.status).toBe("blocked");
    });

    it("task has no assignee_id → skips policy lookup, passes status through", async () => {
      vi.mocked(taskRepo.findById).mockResolvedValue(
        makeTask({ assignee_id: undefined }),
      );
      vi.mocked(taskRepo.updateProgress).mockImplementation(async (id, status, summary) =>
        makeTask({ id, status, result_summary: summary }),
      );

      await service.updateProgress("task_1", "done", "finished");
      expect(agentRepo.findById).not.toHaveBeenCalled();
      expect(taskRepo.updateProgress).toHaveBeenCalledWith("task_1", "done", "finished");
    });
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

describe("TaskService.approveTask (M6.4 split)", () => {
  it("transitions review → done with summary", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "review" }));
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? "review" }),
    );
    const out = await service.approveTask("task_1", "wrapping up");
    expect(out.status).toBe("done");
    expect(taskRepo.update).toHaveBeenCalledWith("task_1", {
      status: "done",
      result_summary: "wrapping up",
    });
  });

  it("allows approving from 'needs_revision' too", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "needs_revision" }));
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? "needs_revision" }),
    );
    const out = await service.approveTask("task_1");
    expect(out.status).toBe("done");
  });

  it("rejects approval from 'blocked' (semantically weird)", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "blocked" }));
    await expect(service.approveTask("task_1")).rejects.toBeInstanceOf(
      InvalidTaskTransitionError,
    );
  });

  it("rejects approval from 'in_progress'", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "in_progress" }));
    await expect(service.approveTask("task_1")).rejects.toBeInstanceOf(
      InvalidTaskTransitionError,
    );
  });

  it("preserves existing result_summary when none is passed", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(
      makeTask({ status: "review", result_summary: "already done" }),
    );
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? "review" }),
    );
    await service.approveTask("task_1");
    expect(taskRepo.update).toHaveBeenCalledWith("task_1", {
      status: "done",
      result_summary: "already done",
    });
  });
});

describe("TaskService.rejectTask (M6.4 split)", () => {
  it.each([
    ["review"],
    ["needs_revision"],
    ["blocked"],
  ] as const)("transitions %s → cancelled", async (status) => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status }));
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? status }),
    );
    const out = await service.rejectTask("task_1", "scope changed");
    expect(out.status).toBe("cancelled");
    expect(taskRepo.update).toHaveBeenCalledWith("task_1", {
      status: "cancelled",
      result_summary: "scope changed",
    });
  });

  it("rejects rejecting from 'in_progress'", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "in_progress" }));
    await expect(service.rejectTask("task_1")).rejects.toBeInstanceOf(
      InvalidTaskTransitionError,
    );
  });
});

describe("TaskService.reviseTask (M6.4 split — source-aware)", () => {
  it("source='human' from 'review' → needs_revision + stamps next_dispatch_context", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "review" }));
    vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue(makeSession());
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? "review" }),
    );

    const out = await service.reviseTask("task_1", "please add tests", { source: "human" });

    expect(out.status).toBe("needs_revision");
    expect(taskRepo.update).toHaveBeenCalledWith("task_1", {
      status: "needs_revision",
      next_dispatch_context: {
        kind: "revision",
        feedback: "please add tests",
        source: "human",
        from_status: "review",
        reviser_agent_id: undefined,
        prior_session_id: "sess_prior",
      },
    });
  });

  it("source='human' from 'needs_revision' (re-revise) is allowed", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "needs_revision" }));
    vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue(makeSession());
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? "needs_revision" }),
    );
    const out = await service.reviseTask("task_1", "more changes", { source: "human" });
    expect(out.status).toBe("needs_revision");
  });

  it("source='human' from 'blocked' is REJECTED (humans don't fix blockers via revise)", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "blocked" }));
    await expect(
      service.reviseTask("task_1", "x", { source: "human" }),
    ).rejects.toBeInstanceOf(InvalidTaskTransitionError);
  });

  it("source='parent_agent' from 'blocked' → needs_revision + stamps reviser_agent_id", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "blocked" }));
    vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue(makeSession());
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? "blocked" }),
    );

    const out = await service.reviseTask(
      "task_1",
      "use the existing pool",
      { source: "parent_agent", reviserAgentId: "agent_parent" },
    );

    expect(out.status).toBe("needs_revision");
    expect(taskRepo.update).toHaveBeenCalledWith("task_1", {
      status: "needs_revision",
      next_dispatch_context: {
        kind: "revision",
        feedback: "use the existing pool",
        source: "parent_agent",
        from_status: "blocked",
        reviser_agent_id: "agent_parent",
        prior_session_id: "sess_prior",
      },
    });
  });

  it("source='parent_agent' from 'review' is REJECTED (parents don't review-cycle revise)", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "review" }));
    await expect(
      service.reviseTask("task_1", "x", { source: "parent_agent" }),
    ).rejects.toBeInstanceOf(InvalidTaskTransitionError);
  });

  it("prior_session_id undefined when prior session has no cli_session_id (mode E)", async () => {
    vi.mocked(taskRepo.findById).mockResolvedValue(makeTask({ status: "review" }));
    vi.mocked(sessionRepo.findLatestForTask).mockResolvedValue(
      makeSession({ cli_session_id: undefined }),
    );
    vi.mocked(taskRepo.update).mockImplementation(async (id, patch) =>
      makeTask({ id, ...patch, status: patch.status ?? "review" }),
    );
    await service.reviseTask("task_1", "x", { source: "human" });
    const call = vi.mocked(taskRepo.update).mock.calls[0]![1];
    expect(call.next_dispatch_context).toMatchObject({
      kind: "revision",
      prior_session_id: undefined,
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
    vi.mocked(workProductRepo.listByTask).mockResolvedValue([
      makeWorkProductListItem(),
    ]);
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
