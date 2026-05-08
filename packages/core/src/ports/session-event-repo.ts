import type { SessionEvent } from "../domain/session.js";

export type NewSessionEvent = Omit<SessionEvent, "created_at">;

export interface SessionEventRepository {
  /** Append one event. Best-effort callers can fire-and-forget; failures only log. */
  append(input: NewSessionEvent): Promise<SessionEvent>;

  /** Read all events for a session, oldest first (transcript order). */
  listBySession(sessionId: string, limit?: number): Promise<SessionEvent[]>;
}
