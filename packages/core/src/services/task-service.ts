import type { Task, TaskStatus } from "../domain/task.js";
import type { WorkProduct } from "../domain/work-product.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type {
  NewWorkProduct,
  WorkProductRepository,
} from "../ports/work-product-repo.js";
import type { TaskRepository } from "../ports/task-repo.js";

export class TaskNotFoundError extends Error {
  readonly code = "TASK_NOT_FOUND";
  constructor(taskId: string) {
    super(`Task ${taskId} not found`);
    this.name = "TaskNotFoundError";
  }
}

export class InvalidTaskTransitionError extends Error {
  readonly code = "INVALID_TASK_TRANSITION";
  constructor(message: string) {
    super(message);
    this.name = "InvalidTaskTransitionError";
  }
}

/** Approval verbs → the terminal status they transition the task to. */
const APPROVAL_TRANSITIONS: Record<"approve" | "reject" | "revise", TaskStatus> = {
  approve: "done",
  reject: "cancelled",
  // "revise" queues the task for re-work; the executor's claim will then
  // transition needs_revision → revision (running as re-work).
  revise: "needs_revision",
};

/**
 * Statuses from which an approval action is legal. `review` is the natural
 * case (agent finished, waiting for human). `needs_revision` lets a reviewer
 * change their mind about a re-work request before the executor picks it
 * up — not allowed once the task is actively re-running (`revision`).
 */
const APPROVABLE_FROM: readonly TaskStatus[] = ["review", "needs_revision"];

/** Cancellation from these requires `force: true`. */
const TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

/** A task is "complete" for the parent-rollup check when it is in one of these. */
const COMPLETE_STATUSES: readonly TaskStatus[] = ["done", "cancelled", "failed"];

export interface TaskServiceDeps {
  taskRepo: TaskRepository;
  workProductRepo: WorkProductRepository;
  /** Looked up on `updateProgress` to apply the agent's `review_policy`. */
  agentRepo: AgentRepository;
}

/**
 * TaskService — domain service for `task`. Encapsulates:
 *   - progress reporting (update_progress MCP tool backend)
 *   - blocker lifecycle (report_blocker + clearBlocker)
 *   - approval state machine (approveTask)
 *   - cancellation with a force override (cancelTask)
 *   - work-product creation + listing
 *   - parent rollup (checkAndCompleteParent)
 *
 * `loadAgentProfile` from intentcore is intentionally dropped — AgentSession
 * loads the agent itself in step 1 of its pipeline.
 *
 * Port of intentcore `packages/engine/src/task-service.ts` with the M3 caveats
 * applied: no `agent.status` filter (column was dropped in M1), no
 * stripNulls / stripTablePrefix helpers (PG doesn't need them), and task
 * metadata reads/writes go through top-level columns (`parent_task_id`,
 * `blocker_agent_id`, `blocker_reason`) rather than a JSONB blob.
 */
export class TaskService {
  constructor(private deps: TaskServiceDeps) {}

  /**
   * Update progress — used by the `update_progress` MCP tool (M6).
   *
   * Applies the agent's `review_policy` as a gate: when the agent declares
   * `done` and its policy is `require_human`, the task is transitioned to
   * `review` instead so a human can sign off before it's truly closed.
   * Undefined policy and `auto_done` both pass `done` through. Other
   * statuses (`failed`, `blocked`, etc.) are never gated — those aren't
   * "I'm finished" claims and don't need review.
   */
  async updateProgress(
    taskId: string,
    status: TaskStatus,
    summary: string,
  ): Promise<Task> {
    const task = await this.requireTask(taskId);

    let finalStatus = status;
    if (status === "done" && task.assignee_id) {
      const agent = await this.deps.agentRepo.findById(task.assignee_id);
      if (agent?.review_policy === "require_human") {
        finalStatus = "review";
      }
    }

    return this.deps.taskRepo.updateProgress(taskId, finalStatus, summary);
  }

  /** Mark blocked (set blocker agent + reason). Used by the `report_blocker` mesh tool (M6). */
  async markBlocked(
    taskId: string,
    blockerAgentId: string,
    reason: string,
  ): Promise<Task> {
    await this.requireTask(taskId);
    return this.deps.taskRepo.markBlocked(taskId, blockerAgentId, reason);
  }

  /** Clear blocker — transitions task back to in_progress. */
  async clearBlocker(taskId: string): Promise<Task> {
    await this.requireTask(taskId);
    return this.deps.taskRepo.clearBlocker(taskId);
  }

  /**
   * Approve / reject / revise a task awaiting review. Valid only when the
   * task is currently in `review` or `needs_revision` (latter lets a
   * reviewer undo a re-work request before the executor claims it).
   */
  async approveTask(
    taskId: string,
    action: "approve" | "reject" | "revise",
    resultSummary?: string,
  ): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (!APPROVABLE_FROM.includes(task.status)) {
      throw new InvalidTaskTransitionError(
        `Cannot ${action} task in status '${task.status}' — must be one of: ${APPROVABLE_FROM.join(", ")}`,
      );
    }
    const nextStatus = APPROVAL_TRANSITIONS[action];
    return this.deps.taskRepo.update(taskId, {
      status: nextStatus,
      result_summary: resultSummary ?? task.result_summary,
    });
  }

  /**
   * Cancel a task. If already in a terminal status (`done`/`cancelled`)
   * requires `force: true` (idempotent no-op when forced).
   */
  async cancelTask(
    taskId: string,
    options: { force?: boolean; reason?: string } = {},
  ): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (TERMINAL_STATUSES.includes(task.status) && !options.force) {
      throw new InvalidTaskTransitionError(
        `Task ${taskId} is already in terminal status '${task.status}'; pass force=true to override`,
      );
    }
    return this.deps.taskRepo.update(taskId, {
      status: "cancelled",
      result_summary: options.reason ?? task.result_summary,
    });
  }

  /** Record a work product (PR, doc, artifact, etc.) produced by a task. */
  async createWorkProduct(input: NewWorkProduct): Promise<WorkProduct> {
    await this.requireTask(input.task_id);
    return this.deps.workProductRepo.create(input);
  }

  /** List work products for a task (chronological order is the repo's concern). */
  async listWorkProducts(taskId: string): Promise<WorkProduct[]> {
    return this.deps.workProductRepo.listByTask(taskId);
  }

  /**
   * If this task has a parent and all siblings are in a complete status
   * (done/cancelled/failed), mark the parent done. No-op otherwise.
   *
   * Called from the MCP tool handler after `updateProgress` lands a child
   * in a complete state.
   */
  async checkAndCompleteParent(taskId: string): Promise<void> {
    const task = await this.deps.taskRepo.findById(taskId);
    if (!task?.parent_task_id) return;
    const parent = await this.deps.taskRepo.findById(task.parent_task_id);
    if (!parent || COMPLETE_STATUSES.includes(parent.status)) return;
    const notComplete = await this.deps.taskRepo.countChildrenNotComplete(
      parent.id,
    );
    if (notComplete === 0) {
      await this.deps.taskRepo.updateProgress(
        parent.id,
        "done",
        parent.result_summary ?? "All subtasks completed.",
      );
    }
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.deps.taskRepo.findById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return task;
  }
}
