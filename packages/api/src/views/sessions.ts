/**
 * Session views — single session by short_id.
 *
 * Lookup uses prefix match on the typed-id (`sess_<6chars>...`) since the
 * UI addresses sessions by 6-char short_id. Collisions are statistically
 * improbable with nanoid but the query LIMIT 2 + 409-on-ambiguous handler
 * makes them safe.
 *
 * Transcript rows come from `session_event` (M8 #47), aggregated server-side
 * via json_agg — single round-trip, transcript-ordered. ask_threads remains
 * an empty stub (mesh-ask threads are a separate backend slice).
 *
 * Cap at 500 events per session in the json_agg subquery — Postgres NOTIFY
 * payloads are size-bounded (8000 bytes) and the chat UI's render cost
 * grows linearly with event count. Sessions over the cap surface a
 * "transcript truncated" affordance in the UI rather than a runaway list.
 */

import type { Pool } from "@beevibe/core/adapters/postgres";
import type {
  HierarchyLevel,
  SessionSpawnMode,
  SessionStatus,
  SessionType,
  SessionUsage,
} from "@beevibe/core";
import {
  computeCacheHitRatio,
  deriveShortId,
  formatDurationLabel,
} from "./format.js";
import type {
  SessionDisplay,
  SessionBriefing,
  SessionUsageDisplay,
  TranscriptEntry,
} from "./types.js";

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
  briefing: SessionBriefing | null;
  agent_label: string;
  agent_hier: HierarchyLevel;
  task_title: string | null;
  transcript: TranscriptEventRow[] | null;
  spawn_mode: SessionSpawnMode | null;
  runtime_id: string | null;
  runtime_cli: string | null;
  runtime_cli_version: string | null;
  daemon_device_name: string | null;
  usage: SessionUsage | null;
}

interface TranscriptEventRow {
  kind: TranscriptEntry["kind"];
  /** ISO string from `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS"Z"')` (no driver Date coercion inside json_agg). */
  timestamp: string;
  content: string;
  tool_name: string | null;
}

const SESSION_BY_ID_PREFIX_SQL = /* sql */ `
SELECT
  s.id, s.agent_id, s.task_id, s.type, s.status, s.intent,
  s.workspace_path, s.cli_session_id, s.started_at, s.completed_at,
  s.briefing, s.spawn_mode, s.runtime_id, s.usage,
  a.name              AS agent_label,
  a.hierarchy_level   AS agent_hier,
  t.title             AS task_title,
  r.cli               AS runtime_cli,
  r.cli_version       AS runtime_cli_version,
  d.device_name       AS daemon_device_name,
  COALESCE(
    (
      SELECT json_agg(
        json_build_object(
          'kind', e.kind,
          'timestamp', to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'content', e.content,
          'tool_name', e.tool_name
        )
      )
      FROM (
        SELECT * FROM session_event
        WHERE session_id = s.id
        ORDER BY created_at ASC, id ASC
        LIMIT 500
      ) e
    ),
    '[]'::json
  ) AS transcript
FROM session s
JOIN agent a ON a.id = s.agent_id
LEFT JOIN task t ON t.id = s.task_id
LEFT JOIN runtime r ON r.id = s.runtime_id
LEFT JOIN daemon d ON d.id = r.daemon_id
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
    briefing: row.briefing ?? emptyBriefing(),
    transcript: (row.transcript ?? []).map(toTranscriptEntry),
    ask_threads: [],
    spawn_mode: row.spawn_mode ?? undefined,
    runtime_id: row.runtime_id ?? undefined,
    runtime_cli: row.runtime_cli ?? undefined,
    runtime_cli_version: row.runtime_cli_version ?? undefined,
    daemon_device_name: row.daemon_device_name ?? undefined,
    usage: toSessionUsageDisplay(row.usage),
  };
}

function toTranscriptEntry(row: TranscriptEventRow): TranscriptEntry {
  return {
    kind: row.kind,
    timestamp: row.timestamp,
    content: row.content,
    ...(row.tool_name ? { tool_name: row.tool_name } : {}),
  };
}

/**
 * Map the raw `SessionUsage` JSONB shape (all fields optional) to the
 * display shape (all fields populated, cache_hit_ratio precomputed).
 * Returns undefined when the row's usage is null so the UI can hide
 * the panel for older sessions captured before M9.8.
 *
 * The cache hit ratio is computed here (not in the UI) so every
 * consumer agrees on the formula and we don't ship "almost correct"
 * derivations across surfaces. Denominator is `total_input` — the sum
 * of all three input slices, per `SessionUsage`'s own contract.
 */
export function toSessionUsageDisplay(
  raw: SessionUsage | null | undefined,
): SessionUsageDisplay | undefined {
  if (!raw) return undefined;
  const input_tokens = raw.input_tokens ?? 0;
  const output_tokens = raw.output_tokens ?? 0;
  const cache_creation_tokens = raw.cache_creation_input_tokens ?? 0;
  const cache_read_tokens = raw.cache_read_input_tokens ?? 0;
  return {
    cost_usd: raw.cost_usd ?? 0,
    cache_hit_ratio: computeCacheHitRatio({
      input: input_tokens,
      cacheCreation: cache_creation_tokens,
      cacheRead: cache_read_tokens,
    }),
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    total_input_tokens:
      input_tokens + cache_creation_tokens + cache_read_tokens,
    model: raw.model && raw.model.length > 0 ? raw.model : "unknown",
  };
}
