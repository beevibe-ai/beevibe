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
   * Most-recent chat sessions for an agent, capped at `limit`. Used by
   * the chat surface to rehydrate history on page load. Bounded so a
   * heavy user with thousands of turns doesn't drag GET /chat.
   */
  listChatForAgent(agentId: string, limit: number): Promise<Session[]>;

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

  /**
   * Atomically claim the oldest pending session bound to `runtimeId` and
   * promote it to `running`. Returns undefined when nothing is pending.
   * Implemented with `SELECT … FOR UPDATE SKIP LOCKED` so concurrent claims
   * by parallel daemons each get a distinct session (or undefined).
   */
  claimNextForRuntime(runtimeId: string): Promise<Session | undefined>;

  /**
   * Atomically claim the oldest pending session that has NO runtime_id
   * bound. Used by the legacy in-process executor as the fallback
   * claimant for agents without a `preferred_runtime_id`. Daemon-bound
   * sessions are never returned — those go to the matching daemon via
   * `claimNextForRuntime`.
   */
  claimNextForServerFallback(): Promise<Session | undefined>;

  /**
   * How many of `sessionIds` are bound to a runtime owned by `daemonId`?
   * Single JOIN round-trip; the /runtime/* surface uses this to gate
   * /events and /done writes against cross-tenant tampering.
   */
  countOwnedByDaemon(daemonId: string, sessionIds: string[]): Promise<number>;

  create(input: NewSession): Promise<Session>;

  update(id: string, patch: SessionPatch): Promise<Session>;
}
