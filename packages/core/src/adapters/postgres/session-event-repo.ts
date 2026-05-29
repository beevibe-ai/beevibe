import type { SessionEvent, SessionEventKind } from "../../domain/session.js";
import type {
  NewSessionEvent,
  SessionEventRepository,
} from "../../ports/session-event-repo.js";
import type { Pool } from "./client.js";

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
    const { rows } = await this.pool.query<EventRow>(
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
    );
    if (!rows[0]) throw new Error("session_event INSERT returned no row");
    return rowToEvent(rows[0]);
  }

  async listBySession(sessionId: string, limit = 500): Promise<SessionEvent[]> {
    const { rows } = await this.pool.query<EventRow>(
      `SELECT * FROM session_event
        WHERE session_id = $1
        ORDER BY created_at ASC
        LIMIT $2`,
      [sessionId, limit],
    );
    return rows.map(rowToEvent);
  }

  async listForSessions(
    sessionIds: string[],
    limitPerSession = 100,
  ): Promise<Map<string, SessionEvent[]>> {
    const out = new Map<string, SessionEvent[]>();
    for (const sid of sessionIds) out.set(sid, []);
    if (sessionIds.length === 0) return out;
    // Per-session LIMIT via a windowed query: rank events by created_at
    // within each session, then keep the most recent N. Output is
    // ordered ASC overall but per-session ASC inside the cap.
    const { rows } = await this.pool.query<EventRow>(
      `WITH ranked AS (
         SELECT *,
                ROW_NUMBER() OVER (
                  PARTITION BY session_id
                  ORDER BY created_at DESC
                ) AS rn
           FROM session_event
          WHERE session_id = ANY($1::text[])
       )
       SELECT id, session_id, kind, content, tool_name, created_at
         FROM ranked
        WHERE rn <= $2
        ORDER BY session_id, created_at ASC`,
      [sessionIds, limitPerSession],
    );
    for (const row of rows) {
      const list = out.get(row.session_id) ?? [];
      list.push(rowToEvent(row));
      out.set(row.session_id, list);
    }
    return out;
  }
}
