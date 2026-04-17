import type { Session, SessionType, SessionStatus, SessionUsage } from "../domain/session.js";

export type NewSession = Omit<Session, "created_at" | "status" | "started_at" | "completed_at"> & {
  status?: SessionStatus;
  started_at?: Date;
};

export type SessionPatch = Partial<
  Omit<Session, "id" | "agent_id" | "task_id" | "type" | "created_at">
> & {
  usage?: SessionUsage;
};

export interface SessionRepository {
  findById(id: string): Promise<Session | undefined>;

  /** Most recent session for this task (by created_at). */
  findLatestForTask(taskId: string): Promise<Session | undefined>;

  listForTask(taskId: string): Promise<Session[]>;

  listForAgent(agentId: string): Promise<Session[]>;

  /**
   * Count currently-running sessions for an agent.
   * Used by capacity checks (max_task_sessions / max_mesh_sessions).
   * `types` groups session kinds: pass `['task']` for task cap, pass the mesh types
   * for the mesh cap.
   */
  countRunningByAgent(agentId: string, types: SessionType[]): Promise<number>;

  /**
   * Find running sessions whose process PID might be dead.
   * Caller filters by `isProcessAlive()` — this returns candidates.
   */
  listRunningWithPid(): Promise<Session[]>;

  create(input: NewSession): Promise<Session>;

  update(id: string, patch: SessionPatch): Promise<Session>;
}
