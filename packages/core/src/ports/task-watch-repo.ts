import type { TaskWatch, TaskWatchStatus } from "../domain/task-watch.js";

export type NewTaskWatch = Omit<
  TaskWatch,
  "status" | "created_at" | "fired_at" | "fired_session_id"
> & {
  status?: TaskWatchStatus;
};

export interface TaskWatchRepository {
  findById(id: string): Promise<TaskWatch | undefined>;
  /** Watches the given waiter session registered, newest first. */
  listByWaiterSession(waiterSessionId: string): Promise<TaskWatch[]>;
  /** Waiting watches whose `task_ids` contains `taskId`; used by the M2 trigger / service to enumerate candidates on a status transition. */
  listWaitingForTask(taskId: string): Promise<TaskWatch[]>;
  create(input: NewTaskWatch): Promise<TaskWatch>;
  /**
   * Mark a watch as fired and link the wake session. Idempotent on the
   * fired→fired re-call (returns the existing row). Throws if the watch
   * is in `aborted` state to surface a race with `unwatch`.
   */
  markFired(id: string, firedSessionId: string): Promise<TaskWatch>;
  /** Mark a waiting watch as aborted (agent-driven `unwatch`). Idempotent. */
  markAborted(id: string): Promise<TaskWatch>;
}
