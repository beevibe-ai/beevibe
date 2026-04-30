/**
 * Session views — single session by short_id.
 *
 * Lookup uses prefix match on the typed-id (`sess_<6chars>...`) since the
 * UI addresses sessions by 6-char short_id. Collisions are statistically
 * improbable with nanoid but the query LIMIT 2 + 409-on-ambiguous handler
 * makes them safe.
 *
 * Briefing / transcript / ask_threads are returned as empty stubs in this
 * cut: the briefing is composed in-process at session start (not persisted
 * in a queryable form), and the transcript lives in the CLI subprocess's
 * stdio — neither is available from the DB alone. Surfacing them is its
 * own backend slice; the empty stubs let the UI render the page chrome
 * (header, status, footer) immediately.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type { HierarchyLevel, SessionStatus, SessionType } from "@beevibe/core";
import { deriveShortId, formatDurationLabel } from "./format.js";
import type { SessionDisplay, SessionBriefing } from "./types.js";

interface SessionDetailRow {
  id: string;
  agent_id: string;
  task_id: string | null;
  type: SessionType;
  status: SessionStatus;
  intent: string;
  workspace_path: string | null;
  cli_session_id: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  agent_label: string;
  agent_hier: HierarchyLevel;
  task_title: string | null;
}

const SESSION_BY_ID_PREFIX_SQL = /* sql */ `
SELECT
  s.id, s.agent_id, s.task_id, s.type, s.status, s.intent,
  s.workspace_path, s.cli_session_id, s.started_at, s.completed_at,
  a.name              AS agent_label,
  a.hierarchy_level   AS agent_hier,
  t.title             AS task_title
FROM session s
JOIN agent a ON a.id = s.agent_id
LEFT JOIN task t ON t.id = s.task_id
WHERE s.id LIKE $1 || '%'
LIMIT 2
`;

export class AmbiguousShortIdError extends Error {
  constructor(public readonly shortId: string) {
    super(`session short_id '${shortId}' matched multiple rows`);
    this.name = "AmbiguousShortIdError";
  }
}

/**
 * Look up a session by its 6-char short_id (e.g. `abc123`). Returns
 * `undefined` for no match. Throws `AmbiguousShortIdError` when 2+ session
 * rows share the prefix — the route maps this to 409.
 */
export async function getSessionByShortId(
  pool: Pool,
  shortId: string,
): Promise<SessionDisplay | undefined> {
  if (!/^[a-z0-9]+$/i.test(shortId)) return undefined;
  const prefix = `sess_${shortId}`;
  const { rows } = await pool.query<SessionDetailRow>(
    SESSION_BY_ID_PREFIX_SQL,
    [prefix],
  );
  if (rows.length === 0) return undefined;
  if (rows.length > 1) throw new AmbiguousShortIdError(shortId);
  return rowToSessionDisplay(rows[0]!);
}

function emptyBriefing(): SessionBriefing {
  return {
    block_count: 0,
    fact_count: 0,
    token_count: 0,
    blocks: [],
    facts: [],
  };
}

function rowToSessionDisplay(row: SessionDetailRow): SessionDisplay {
  return {
    id: row.id,
    short_id: deriveShortId(row.id),
    task_id: row.task_id ?? "",
    task_title: row.task_title ?? "(untitled task)",
    task_short_id: row.task_id ? deriveShortId(row.task_id) : "",
    agent_id: row.agent_id,
    agent_label: row.agent_label,
    agent_hierarchy: row.agent_hier,
    type: row.type,
    status: row.status,
    intent: row.intent,
    started_at: row.started_at ?? new Date(0),
    duration_label: formatDurationLabel(row.started_at, row.completed_at),
    worktree: row.workspace_path ?? undefined,
    cli_session: row.cli_session_id ?? undefined,
    briefing: emptyBriefing(),
    transcript: [],
    ask_threads: [],
  };
}
