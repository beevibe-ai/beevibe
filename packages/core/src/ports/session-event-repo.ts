import type { SessionEvent } from "../domain/session.js";

export type NewSessionEvent = Omit<SessionEvent, "created_at">;

export interface SessionEventRepository {
  /** Append one event. Best-effort callers can fire-and-forget; failures only log. */
  append(input: NewSessionEvent): Promise<SessionEvent>;

  /** Read all events for a session, oldest first (transcript order). */
  listBySession(sessionId: string, limit?: number): Promise<SessionEvent[]>;

  /**
   * Batch-fetch events for multiple sessions in one round-trip, oldest
   * first within each session. Used by chat/room history endpoints to
   * attach the intermediate-step transcript to each agent message
   * without firing N+1 queries.
   *
   * `limitPerSession` caps how many events to return per session
   * (most recent kept). Returns a Map keyed by session_id; sessions
   * with no events get an empty array.
   */
  listForSessions(
    sessionIds: string[],
    limitPerSession?: number,
  ): Promise<Map<string, SessionEvent[]>>;
}
