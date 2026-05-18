import type { NextDispatchContext, Task, TaskStatus } from "../domain/task.js";
import type { WorkProduct, WorkProductListItem } from "../domain/work-product.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type {
  NewWorkProduct,
  WorkProductPatch,
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

// ── Per-method accepted-from sets (M6.4 split) ────────────────────────────
//
// Each method has its own "approvable from" set, narrowed source-aware for
// reviseTask. Approve from `blocked` would be semantically weird ("the work
// is good as-is" while blocked); reject and revise from `blocked` are both
// legitimate (forget about it, or here's how to unblock).

const APPROVE_FROM: readonly TaskStatus[] = ["review", "needs_revision"];
const REJECT_FROM: readonly TaskStatus[] = ["review", "needs_revision", "blocked"];

/** Source-aware revise-from sets. Validated in reviseTask. */
const HUMAN_REVISE_FROM: readonly TaskStatus[] = ["review", "needs_revision"];
const PARENT_AGENT_REVISE_FROM: readonly TaskStatus[] = ["blocked"];

/** Cancellation from these requires `force: true`. */
const TERMINAL_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

/** A task is "complete" for the parent-rollup check when it is in one of these. */
const COMPLETE_STATUSES: readonly TaskStatus[] = ["done", "cancelled", "failed"];

export interface TaskServiceDeps {
  taskRepo: TaskRepository;
  workProductRepo: WorkProductRepository;
  /** Looked up on `updateProgress` to apply the agent's `review_policy`. */
  agentRepo: AgentRepository;
  /**
   * M6.4: required by `reviseTask` to look up the prior session (used as
   * `priorSessionId` in the stamped `next_dispatch_context`). Other methods
   * don't touch sessionRepo, but the dep is unconditional to keep
   * construction simple.
   */
  sessionRepo: SessionRepository;
}

export interface ReviseTaskOptions {
  /**
   * Required. Discriminates valid from-statuses + frames the resumed
   * agent's intent prompt:
   *   - `human`        ← review-cycle revision (POST /task/:id/revise)
   *   - `parent_agent` ← post-blocker fix (revise_task MCP tool)
   */
  source: "human" | "parent_agent";
  /** When source='parent_agent', the calling parent's agent id. */
  reviserAgentId?: string;
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

    // Reject late updates from agents whose task was already terminated
    // by a human (cancel) or by a successful close (done). Without this
    // guard, an agent that runs to completion AFTER a human cancel can
    // silently overwrite the cancelled status — the user's intervention
    // gets undone and the result_summary "(cancelled by …)" is lost.
    if (TERMINAL_STATUSES.includes(task.status)) {
      throw new InvalidTaskTransitionError(
        `update_progress on task ${taskId}: task is already in terminal status '${task.status}'. ` +
          `Exit your session — no further updates accepted.`,
      );
    }

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
   * Approve a task: terminal transition `review|needs_revision → done`.
   * Used by `POST /task/:id/approve` (human only).
   */
  async approveTask(taskId: string, resultSummary?: string): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (!APPROVE_FROM.includes(task.status)) {
      throw new InvalidTaskTransitionError(
        `Cannot approve task in status '${task.status}' — must be one of: ${APPROVE_FROM.join(", ")}`,
      );
    }
    return this.deps.taskRepo.update(taskId, {
      status: "done",
      result_summary: resultSummary ?? task.result_summary,
    });
  }

  /**
   * Reject a task: terminal transition `review|needs_revision|blocked →
   * cancelled`. Used by `POST /task/:id/reject` (human only).
   */
  async rejectTask(taskId: string, resultSummary?: string): Promise<Task> {
    const task = await this.requireTask(taskId);
    if (!REJECT_FROM.includes(task.status)) {
      throw new InvalidTaskTransitionError(
        `Cannot reject task in status '${task.status}' — must be one of: ${REJECT_FROM.join(", ")}`,
      );
    }
    return this.deps.taskRepo.update(taskId, {
      status: "cancelled",
      result_summary: resultSummary ?? task.result_summary,
    });
  }

  /**
   * Revise a task: re-queue with feedback. Source-aware:
   *   - `human` from review|needs_revision (review cycle)
   *   - `parent_agent` from blocked (post-blocker fix via revise_task MCP)
   *
   * Stamps `task.next_dispatch_context` with the revision context (kind,
   * source, from_status, feedback, prior_session_id) so dispatch.ts (M6.5)
   * can build the right intent without re-deriving the from-state.
   *
   * Used by both `POST /task/:id/revise` (human) and the `revise_task` MCP
   * tool (parent-agent). `result_summary` is preserved — only
   * `next_dispatch_context` is mutated, so the agent's prior summary
   * remains visible for audit.
   */
  async reviseTask(
    taskId: string,
    feedback: string,
    opts: ReviseTaskOptions,
  ): Promise<Task> {
    const task = await this.requireTask(taskId);
    const allowedFrom =
      opts.source === "human" ? HUMAN_REVISE_FROM : PARENT_AGENT_REVISE_FROM;
    if (!allowedFrom.includes(task.status)) {
      throw new InvalidTaskTransitionError(
        `Cannot revise task in status '${task.status}' from source '${opts.source}'. ` +
          `Allowed from-statuses for source='${opts.source}': ${allowedFrom.join(", ")}`,
      );
    }

    // Look up prior session for --resume continuity. cli_session_id-guarded:
    // a session row without a started CLI subprocess (rare; e.g., spawn
    // failed) can't be resumed.
    const priorSession = await this.deps.sessionRepo.findLatestForTask(taskId);
    const priorSessionId = priorSession?.cli_session_id ? priorSession.id : undefined;

    const nextDispatchContext: NextDispatchContext = {
      kind: "revision",
      feedback,
      source: opts.source,
      // Captured BEFORE the UPDATE so buildIntent can frame the resumed
      // intent correctly (especially blocked → revision post-blocker case).
      from_status: task.status as "review" | "needs_revision" | "blocked",
      reviser_agent_id: opts.reviserAgentId,
      prior_session_id: priorSessionId,
    };

    return this.deps.taskRepo.update(taskId, {
      status: "needs_revision",
      next_dispatch_context: nextDispatchContext,
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

  /** List work products for a task (body content omitted; see WorkProductListItem). */
  async listWorkProducts(taskId: string): Promise<WorkProductListItem[]> {
    return this.deps.workProductRepo.listByTask(taskId);
  }

  async getWorkProduct(id: string): Promise<WorkProduct | undefined> {
    return this.deps.workProductRepo.findById(id);
  }

  /**
   * Amend a work product (used by the `update_work_product` MCP tool — see M9
   * for the agent skill that decides between create vs update). Mutable
   * subset is `summary | body | url | provider | external_id | metadata`;
   * identity (`type`, `title`, `task_id`, `agent_id`) is fixed at creation.
   *
   * Bumps `updated_at = NOW()` via the repo. Throws if the row doesn't
   * exist (`work_product <id> not found`).
   */
  async updateWorkProduct(
    id: string,
    patch: WorkProductPatch,
  ): Promise<WorkProduct> {
    return this.deps.workProductRepo.update(id, patch);
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
