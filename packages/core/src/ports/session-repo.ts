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

  /**
   * Most recent session this agent had inside a given room. Used by
   * the room route to chain `prior_session_id` so an agent resumes
   * its CLI conversation across @-mentions in the same room (warm
   * prompt cache + continuous agent memory) instead of cold-starting
   * every turn.
   */
  findLatestForAgentInRoom(agentId: string, roomId: string): Promise<Session | undefined>;

  /**
   * In-flight sessions for a room — anything currently `running`.
   * Used by the room view to render "X is typing…" indicators while
   * the agent is working so the room doesn't fall silent during the
   * 5–30s an agent takes to think.
   */
  listRunningInRoom(roomId: string): Promise<Session[]>;

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
