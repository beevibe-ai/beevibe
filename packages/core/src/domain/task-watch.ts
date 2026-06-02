/**
 * Task-watch domain. A team agent registers a `task_watch` row before
 * ending its session to declare "wake me when these dispatched tasks
 * finish." When a watched task transitions to a terminal status (done,
 * failed, cancelled), the M2 DB trigger inserts a new session in the
 * waiter's `prior_session_id` chain so the agent resumes with full
 * context via `claude --resume`.
 *
 * Blockers are NOT this mechanism's concern — the existing mesh server
 * already spawns dedicated sessions for the team to handle blockers
 * and asks. Watches stay `waiting` through blocker/needs_revision and
 * only fire on the eventual terminal transition.
 */

export type TaskWatchMode = "all" | "any";
export type TaskWatchStatus = "waiting" | "fired" | "aborted";

export interface TaskWatch {
  id: string;
  /** Session that called watch_tasks; the wake session chains off this via prior_session_id. */
  waiter_session_id: string;
  /** Owner agent (the waiter session's agent). Stamped at create to simplify auth checks. */
  agent_id: string;
  mode: TaskWatchMode;
  /** Task ids the agent is waiting on; non-empty. */
  task_ids: string[];
  /** Short freeform note surfaced in the wake intent for the agent's future self. */
  reason?: string;
  status: TaskWatchStatus;
  created_at: Date;
  fired_at?: Date;
  /** The wake session inserted by the trigger; set when status === 'fired'. */
  fired_session_id?: string;
}
