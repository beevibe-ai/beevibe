import type { SessionEvent, SessionEventKind } from "../../domain/session.js";
import type {
  NewSessionEvent,
  SessionEventRepository,
} from "../../ports/session-event-repo.js";
import type { Pool } from "./client.js";
import { insertReturning, queryMany } from "./pg-helpers.js";

interface EventRow {
  id: string;
  session_id: string;
  kind: string;
  content: string;
  tool_name: string | null;
  created_at: Date;
}

function rowToEvent(row: EventRow): SessionEvent {
  return {
    id: row.id,
    session_id: row.session_id,
    kind: row.kind as SessionEventKind,
    content: row.content,
    tool_name: row.tool_name ?? undefined,
    created_at: row.created_at,
  };
}

export class PostgresSessionEventRepository implements SessionEventRepository {
  constructor(private pool: Pool) {}

  async append(input: NewSessionEvent): Promise<SessionEvent> {
    // Single round-trip: INSERT the event and bump session.last_event_at
    // in the same statement via a CTE. The orphan reaper (Phase 6+)
    // depends on last_event_at being maintained — without this, every
    // running session looks orphaned forever.
    return insertReturning(
      this.pool,
      "session_event",
      `WITH ev AS (
         INSERT INTO session_event (id, session_id, kind, content, tool_name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *
       ),
       _ AS (
         UPDATE session SET last_event_at = now()
           WHERE id = $2
       )
       SELECT * FROM ev`,
      [input.id, input.session_id, input.kind, input.content, input.tool_name ?? null],
      rowToEvent,
    );
  }

  async listBySession(sessionId: string, limit = 500): Promise<SessionEvent[]> {
    return queryMany(
      this.pool,
      `SELECT * FROM session_event
        WHERE session_id = $1
        ORDER BY created_at ASC
        LIMIT $2`,
      [sessionId, limit],
      rowToEvent,
    );
  }
}
