import type { Task, TaskStatus, TaskPriority } from "../domain/task.js";

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

  /**
   * Bulk lookup. Returns rows for the ids that exist, in input order; missing
   * ids are silently dropped. Single SELECT, used by callers that fan out
   * per-id reads (e.g. WatchService's already-terminal check).
   */
  findByIds(ids: string[]): Promise<Task[]>;

  list(filter?: TaskListFilter): Promise<Task[]>;

  listByAssignee(assigneeId: string): Promise<Task[]>;

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
