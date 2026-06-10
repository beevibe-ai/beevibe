import type {
  BrowseRequest,
  BrowseResult,
  DiscoverHit,
  DiscoverRequest,
  DiscoverResult,
  ReadRequest,
  ReadResult,
  ScrollRequest,
  ScrollResult,
  SessionMetaPreview,
  SessionSearchFilters,
  SessionSearchMsg,
  SessionSearchMsgKind,
} from "../../domain/session-search.js";
import { parseUserMessageId, userMessageId } from "../../domain/session-search.js";
import type {
  SessionSearchRepository,
  SessionSearchScope,
} from "../../ports/session-search-repo.js";
import type { Pool } from "./client.js";

// ── Constants ─────────────────────────────────────────────────────────

/** Max distinct lineages discover returns. Caller-side clamp also applies. */
const DISCOVER_MAX_LIMIT = 10;
const DISCOVER_DEFAULT_LIMIT = 3;
const BROWSE_MAX_LIMIT = 10;
const BROWSE_DEFAULT_LIMIT = 5;
const SCROLL_MAX_WINDOW = 20;
const SCROLL_DEFAULT_WINDOW = 5;
const BOOKEND_SIZE = 3;
const DISCOVER_WINDOW_SIZE = 5;
const READ_HEAD = 20;
const READ_TAIL = 10;
/** Soft pre-limit for FTS results before dedupe — widens recall. */
const FTS_RAW_LIMIT = 50;

const HEADLINE_OPTS = "MaxFragments=2, MinWords=3, MaxWords=15";

// ── Row types ─────────────────────────────────────────────────────────

interface SessionMetaRow {
  id: string;
  conversation_id: string | null;
  type: string;
  status: string;
  agent_id: string;
  task_id: string | null;
  intent: string;
  created_at: Date;
  completed_at: Date | null;
  result_summary: string | null;
}

interface LineageMsgRow {
  id: string;
  session_id: string;
  kind: string;
  content: string;
  tool_name: string | null;
  created_at: Date;
}

interface DiscoveryRow {
  session_id: string;
  lineage_key: string;
  message_id: string;
  matched_role: string;
  snippet: string;
  match_created_at: Date;
}

// ── Helpers ───────────────────────────────────────────────────────────

function rowToMeta(row: SessionMetaRow): SessionMetaPreview {
  return {
    session_id: row.id,
    conversation_id: row.conversation_id,
    type: row.type as SessionMetaPreview["type"],
    status: row.status as SessionMetaPreview["status"],
    agent_id: row.agent_id,
    task_id: row.task_id,
    intent_preview: row.intent.slice(0, 200),
    created_at: row.created_at.toISOString(),
    completed_at: row.completed_at?.toISOString() ?? null,
    result_summary: row.result_summary,
  };
}

function rowToMsg(row: LineageMsgRow, anchorId?: string): SessionSearchMsg {
  const m: SessionSearchMsg = {
    id: row.id,
    session_id: row.session_id,
    kind: row.kind as SessionSearchMsgKind,
    content: row.content,
    created_at: row.created_at.toISOString(),
  };
  if (row.tool_name) m.tool_name = row.tool_name;
  if (anchorId && row.id === anchorId) m.anchor = true;
  return m;
}

/**
 * Append filter conditions to a query. Returns the next param index after
 * binding the supplied values onto `params`. The caller must thread the
 * starting `nextIdx` through.
 *
 * Generates only conditions that apply to the `session` table (aliased `s`).
 * Used by every shape (discover, scroll, read, browse).
 */
function appendFilterClauses(
  filters: SessionSearchFilters | undefined,
  params: unknown[],
  startingIdx: number,
): { sql: string; nextIdx: number } {
  let idx = startingIdx;
  const clauses: string[] = [];
  if (filters?.session_type) {
    clauses.push(`s.type = $${idx++}`);
    params.push(filters.session_type);
  }
  if (filters?.status) {
    clauses.push(`s.status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters?.agent_id) {
    clauses.push(`s.agent_id = $${idx++}`);
    params.push(filters.agent_id);
  }
  if (filters?.task_id) {
    clauses.push(`s.task_id = $${idx++}`);
    params.push(filters.task_id);
  }
  if (filters?.since) {
    clauses.push(`s.created_at >= $${idx++}`);
    params.push(filters.since);
  }
  if (filters?.until) {
    clauses.push(`s.created_at <= $${idx++}`);
    params.push(filters.until);
  }
  return { sql: clauses.length ? " AND " + clauses.join(" AND ") : "", nextIdx: idx };
}

// ── Implementation ────────────────────────────────────────────────────

export class PostgresSessionSearchRepository implements SessionSearchRepository {
  constructor(private pool: Pool) {}

  // ── Public API ─────────────────────────────────────────────────────

  async discover(
    req: DiscoverRequest,
    scope: SessionSearchScope,
  ): Promise<DiscoverResult> {
    if (scope.agent_ids.length === 0) {
      return { kind: "discover", query: req.query, hits: [], lineages_searched: 0 };
    }

    const limit = clamp(req.limit ?? DISCOVER_DEFAULT_LIMIT, 1, DISCOVER_MAX_LIMIT);
    const sort = req.sort;
    const rawLimit = Math.max(FTS_RAW_LIMIT, limit * 5);

    const params: unknown[] = [req.query, scope.agent_ids];
    let idx = 3;
    const exclSql = scope.exclude_lineage_keys.length
      ? `AND COALESCE(s.conversation_id, s.id) <> ALL ($${idx++}::text[])`
      : "";
    if (scope.exclude_lineage_keys.length) {
      params.push(scope.exclude_lineage_keys);
    }
    const { sql: filterSql, nextIdx: idx2 } = appendFilterClauses(req.filters, params, idx);
    idx = idx2;
    const orderClause = sortToOrderBy(sort);
    params.push(rawLimit);
    const rawLimitIdx = idx++;

    // Two-source UNION ALL: intent (user turns) and agent events.
    // Dedupe by lineage_key via DISTINCT ON, picking the best-ranked
    // message per lineage. Then sort by `sort` or rank.
    const query = `
      WITH q AS (
        SELECT websearch_to_tsquery('english', $1) AS ts
      ),
      raw AS (
        -- User turns
        SELECT
          s.id            AS session_id,
          COALESCE(s.conversation_id, s.id) AS lineage_key,
          ${userMessageIdExpr("s.id")}    AS message_id,
          'user'          AS matched_role,
          ts_rank(s.intent_fts, q.ts)     AS rank,
          ts_headline('english', s.intent, q.ts, '${HEADLINE_OPTS}') AS snippet,
          s.created_at    AS match_created_at
        FROM session s, q
        WHERE s.intent_fts @@ q.ts
          AND s.agent_id = ANY($2::text[])
          ${exclSql}${filterSql}
        UNION ALL
        -- Agent events
        SELECT
          s.id            AS session_id,
          COALESCE(s.conversation_id, s.id) AS lineage_key,
          ev.id           AS message_id,
          'agent'         AS matched_role,
          ts_rank(ev.content_fts, q.ts)   AS rank,
          ts_headline('english', ev.content, q.ts, '${HEADLINE_OPTS}') AS snippet,
          ev.created_at   AS match_created_at
        FROM session_event ev
        JOIN session s ON s.id = ev.session_id
        CROSS JOIN q
        WHERE ev.kind = 'agent'
          AND ev.content_fts @@ q.ts
          AND s.agent_id = ANY($2::text[])
          ${exclSql}${filterSql}
      ),
      ranked AS (
        SELECT DISTINCT ON (lineage_key) *
        FROM raw
        ORDER BY lineage_key, rank DESC, match_created_at DESC
      )
      SELECT *
      FROM ranked
      ORDER BY ${orderClause}
      LIMIT $${rawLimitIdx}
    `;

    const { rows } = await this.pool.query<DiscoveryRow>(query, params);
    const lineagesSearched = rows.length;
    const topRows = rows.slice(0, limit);

    const hits: DiscoverHit[] = [];
    for (const r of topRows) {
      const hit = await this.buildHit(r);
      if (hit) hits.push(hit);
    }

    return {
      kind: "discover",
      query: req.query,
      hits,
      lineages_searched: lineagesSearched,
    };
  }

  async scroll(
    req: ScrollRequest,
    scope: SessionSearchScope,
  ): Promise<ScrollResult | null> {
    if (scope.agent_ids.length === 0) return null;

    const meta = await this.getSessionMetaIfInScope(req.session_id, scope);
    if (!meta) return null;

    // Reject scrolls into the caller's active lineage — those messages
    // are already in context. Mirrors Hermes's same guard.
    const lineageKey = meta.conversation_id ?? meta.session_id;
    if (scope.exclude_lineage_keys.includes(lineageKey)) return null;

    const window = clamp(req.window ?? SCROLL_DEFAULT_WINDOW, 1, SCROLL_MAX_WINDOW);
    const anchorId = req.around_message_id;

    const all = await this.getLineageMessages(lineageKey);
    const anchorIdx = all.findIndex((m) => m.id === anchorId);
    if (anchorIdx === -1) return null;

    const start = Math.max(0, anchorIdx - window);
    const end = Math.min(all.length, anchorIdx + window + 1);
    const messages = all.slice(start, end).map((row) => rowToMsg(row, anchorId));

    return {
      kind: "scroll",
      session: meta,
      around_message_id: anchorId,
      window,
      messages,
      messages_before: anchorIdx,
      messages_after: all.length - anchorIdx - 1,
    };
  }

  async read(req: ReadRequest, scope: SessionSearchScope): Promise<ReadResult | null> {
    if (scope.agent_ids.length === 0) return null;

    const meta = await this.getSessionMetaIfInScope(req.session_id, scope);
    if (!meta) return null;

    // For chats, read the whole conversation. For task/mesh/blocker/run_repo,
    // read just the session. Matches the natural "what was this conversation
    // about" intent — chat turns are tiny without context, task sessions are
    // self-contained.
    const lineageKey = meta.conversation_id ?? meta.session_id;
    const all = await this.getLineageMessages(lineageKey);
    const total = all.length;
    const truncated = total > READ_HEAD + READ_TAIL;
    const slice = truncated
      ? [...all.slice(0, READ_HEAD), ...all.slice(-READ_TAIL)]
      : all;

    return {
      kind: "read",
      session: meta,
      message_count: total,
      truncated,
      messages: slice.map((row) => rowToMsg(row)),
    };
  }

  async browse(req: BrowseRequest, scope: SessionSearchScope): Promise<BrowseResult> {
    if (scope.agent_ids.length === 0) return { kind: "browse", sessions: [] };
    const limit = clamp(req.limit ?? BROWSE_DEFAULT_LIMIT, 1, BROWSE_MAX_LIMIT);

    const params: unknown[] = [scope.agent_ids];
    let idx = 2;
    const exclSql = scope.exclude_lineage_keys.length
      ? `AND COALESCE(s.conversation_id, s.id) <> ALL ($${idx++}::text[])`
      : "";
    if (scope.exclude_lineage_keys.length) {
      params.push(scope.exclude_lineage_keys);
    }
    const { sql: filterSql } = appendFilterClauses(req.filters, params, idx);

    // DISTINCT ON the lineage_key, picking the row with the latest activity
    // as the canonical representative for the lineage. PostgreSQL requires
    // DISTINCT ON expressions to match the leading ORDER BY entries, so we
    // sort by lineage_key first and then again in JS to surface most-recent.
    const query = `
      SELECT DISTINCT ON (COALESCE(s.conversation_id, s.id))
        s.id, s.conversation_id, s.type, s.status, s.agent_id, s.task_id,
        s.intent, s.created_at, s.completed_at, s.result_summary
      FROM session s
      WHERE s.agent_id = ANY($1::text[])
        ${exclSql}${filterSql}
      ORDER BY COALESCE(s.conversation_id, s.id), s.created_at DESC
    `;
    const { rows } = await this.pool.query<SessionMetaRow>(query, params);
    rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
    return {
      kind: "browse",
      sessions: rows.slice(0, limit).map(rowToMeta),
    };
  }

  // ── Internals ──────────────────────────────────────────────────────

  private async buildHit(row: DiscoveryRow): Promise<DiscoverHit | null> {
    const meta = await this.getSessionMeta(row.session_id);
    if (!meta) return null;
    const lineageKey = meta.conversation_id ?? meta.session_id;
    const lineageMsgs = await this.getLineageMessages(lineageKey);

    // ±5 window around the matched message
    const anchorIdx = lineageMsgs.findIndex((m) => m.id === row.message_id);
    if (anchorIdx === -1) return null;
    const start = Math.max(0, anchorIdx - DISCOVER_WINDOW_SIZE);
    const end = Math.min(lineageMsgs.length, anchorIdx + DISCOVER_WINDOW_SIZE + 1);
    const window = lineageMsgs.slice(start, end).map((m) => rowToMsg(m, row.message_id));

    // Bookends: first 3 + last 3 user-or-agent messages.
    const significant = lineageMsgs.filter((m) => m.kind === "user" || m.kind === "agent");
    const bookendStart = significant.slice(0, BOOKEND_SIZE).map((m) => rowToMsg(m));
    const bookendEnd = significant.slice(-BOOKEND_SIZE).map((m) => rowToMsg(m));
    // Avoid showing the same message twice when the lineage is tiny.
    const seen = new Set(bookendStart.map((m) => m.id));
    const bookendEndDeduped = bookendEnd.filter((m) => !seen.has(m.id));

    return {
      session: meta,
      match_message_id: row.message_id,
      matched_role: row.matched_role as SessionSearchMsgKind,
      snippet: row.snippet,
      bookend_start: bookendStart,
      messages: window,
      bookend_end: bookendEndDeduped,
      messages_before: anchorIdx,
      messages_after: lineageMsgs.length - anchorIdx - 1,
    };
  }

  private async getSessionMeta(sessionId: string): Promise<SessionMetaPreview | null> {
    const { rows } = await this.pool.query<SessionMetaRow>(
      `SELECT id, conversation_id, type, status, agent_id, task_id,
              intent, created_at, completed_at, result_summary
         FROM session
        WHERE id = $1`,
      [sessionId],
    );
    return rows[0] ? rowToMeta(rows[0]) : null;
  }

  private async getSessionMetaIfInScope(
    sessionId: string,
    scope: SessionSearchScope,
  ): Promise<SessionMetaPreview | null> {
    const meta = await this.getSessionMeta(sessionId);
    if (!meta) return null;
    if (!scope.agent_ids.includes(meta.agent_id)) return null;
    return meta;
  }

  /**
   * Unified message stream for one lineage. For chats this spans every
   * session sharing the conversation_id; for non-chat sessions it's the
   * one session.
   *
   * Order is `created_at` ascending across both sources. User-turn rows
   * (synthesised from `session.intent`) come before any events on the
   * same session via the `source_order` tiebreaker — the intent is the
   * trigger for that session's events.
   */
  private async getLineageMessages(lineageKey: string): Promise<LineageMsgRow[]> {
    const { rows } = await this.pool.query<LineageMsgRow & { source_order: number }>(
      `
      WITH lineage AS (
        SELECT id, intent, created_at
          FROM session
         WHERE COALESCE(conversation_id, id) = $1
      ),
      stream AS (
        SELECT
          ${userMessageIdExpr("ls.id")} AS id,
          ls.id        AS session_id,
          'user'       AS kind,
          ls.intent    AS content,
          NULL::text   AS tool_name,
          ls.created_at,
          1            AS source_order
        FROM lineage ls
        UNION ALL
        SELECT
          ev.id, ev.session_id, ev.kind, ev.content, ev.tool_name, ev.created_at,
          2            AS source_order
        FROM session_event ev
        JOIN lineage ls ON ls.id = ev.session_id
      )
      SELECT id, session_id, kind, content, tool_name, created_at, source_order
        FROM stream
       ORDER BY created_at ASC, source_order ASC, id ASC
      `,
      [lineageKey],
    );
    return rows;
  }
}

// ── SQL helpers ───────────────────────────────────────────────────────

/** `intent:<session_id>` expressed in SQL — must agree with userMessageId(). */
function userMessageIdExpr(sessionIdExpr: string): string {
  return `('intent:' || ${sessionIdExpr})`;
}

function sortToOrderBy(sort: "newest" | "oldest" | undefined): string {
  if (sort === "newest") return "match_created_at DESC, rank DESC";
  if (sort === "oldest") return "match_created_at ASC, rank DESC";
  return "rank DESC, match_created_at DESC";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

// Re-export id helpers for service-layer convenience.
export { userMessageId, parseUserMessageId };
