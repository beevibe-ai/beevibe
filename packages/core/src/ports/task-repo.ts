import type { Task, TaskStatus, TaskPriority, CreatorType } from "../domain/task.js";

export type NewTask = Omit<Task, "created_at" | "updated_at" | "status"> & {
  status?: TaskStatus;
};

export type TaskPatch = Partial<Omit<Task, "id" | "created_at" | "updated_at">>;

export interface TaskListFilter {
  status?: TaskStatus | TaskStatus[];
  assignee_id?: string;
  creator_id?: string;
  parent_task_id?: string;
  priority?: TaskPriority;
}

export interface TaskRepository {
  findById(id: string): Promise<Task | undefined>;

  list(filter?: TaskListFilter): Promise<Task[]>;

  listByAssignee(assigneeId: string): Promise<Task[]>;

  /**
   * All assignable tasks — `status IN ('assigned','needs_revision')` with a
   * non-null assignee — ordered by semantic priority DESC (critical > high >
   * medium > low) then created_at ASC. Cheap read, index-backed. No limit
   * arg: capacity gating in the worker bounds throughput naturally.
   */
  listAssignable(): Promise<Task[]>;

  /**
   * Atomically transition one task out of its queue status into the matching
   * running status:
   *   - `assigned`       → `in_progress`  (fresh work)
   *   - `needs_revision` → `revision`     (re-work; dispatch reads this to
   *                                        pass priorSessionId for --resume)
   *
   * Returns `undefined` if the row's status changed since `listAssignable`
   * (race loser under multiple concurrent executors).
   */
  claimById(taskId: string): Promise<Task | undefined>;

  /** Tasks awaiting human decision: status ∈ {review, revision}. */
  listReviewQueue(): Promise<Task[]>;

  /** Count of sub-tasks of `parentId` whose status is NOT in {done, cancelled, failed}. */
  countChildrenNotComplete(parentId: string): Promise<number>;

  /**
   * Count of all sub-tasks of `parentId` regardless of status. Used by
   * postDispatchCheck (M6.5) to distinguish leaf tasks (childTotal=0,
   * eligible for nudge-completion retry) from parents (childTotal>0, leave
   * alone).
   */
  countChildren(parentId: string): Promise<number>;

  create(input: NewTask): Promise<Task>;

  /** Generic patch update. Sets updated_at = NOW() automatically. */
  update(id: string, patch: TaskPatch): Promise<Task>;

  /** Update status + result_summary atomically (used by update_progress tool). */
  updateProgress(id: string, status: TaskStatus, summary: string): Promise<Task>;

  /**
   * Mark task blocked: sets status = 'blocked' + blocker_agent_id + blocker_reason.
   * Caller is responsible for ensuring the blocker agent is the appropriate resolver.
   */
  markBlocked(id: string, blockerAgentId: string, reason: string): Promise<Task>;

  /**
   * Clear blocker state: status back to in_progress, blocker_* cleared.
   */
  clearBlocker(id: string): Promise<Task>;

  delete(id: string): Promise<void>;
}

export type TaskCreatorInput = {
  creator_id: string;
  creator_type: CreatorType;
};
