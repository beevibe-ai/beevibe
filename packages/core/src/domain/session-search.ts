import type { SessionType, SessionStatus } from "./session.js";

/**
 * session_search — Beevibe's Layer-3 memory: FTS over past conversations.
 *
 * Adapted from Hermes Agent's session_search (single tool, four calling
 * shapes inferred from args). Three differences vs Hermes:
 *   1. Substrate: Postgres tsvector + GIN, not SQLite FTS5.
 *   2. Lineage: `conversation_id` lookup, not parent_session_id recursion.
 *   3. Beevibe-specific filters: session_type, status, agent_id, task_id,
 *      time range. Tier/owner scoping is enforced by the service layer.
 *
 * The repo layer is scope-agnostic — it receives a resolved set of
 * agent_ids + lineage exclusions and runs the query. The service layer
 * derives that scope from the caller's hierarchy_level.
 */

// ── Message-stream shape ──────────────────────────────────────────────

/**
 * Logical roles in the unified message stream. We synthesise one "user"
 * message per session from {@link Session.intent}; assistant turns come
 * from {@link SessionEvent} rows with kind='agent'; tool I/O is exposed
 * in scroll/read shapes but never indexed for discovery.
 */
export type SessionSearchMsgKind =
  | "user"
  | "agent"
  | "tool_call"
  | "tool_result"
  | "summary";

export interface SessionSearchMsg {
  /**
   * Stable identifier the agent can pass back to scroll. For user
   * messages this is `intent:<session_id>` — the intent column has no
   * row id of its own. For everything else this is the raw session_event
   * row id.
   */
  id: string;
  session_id: string;
  kind: SessionSearchMsgKind;
  content: string;
  tool_name?: string;
  created_at: string;
  /** Flagged when this message is the FTS match anchor (discovery shape). */
  anchor?: boolean;
}

// ── Filters ───────────────────────────────────────────────────────────

export interface SessionSearchFilters {
  /** Restrict to one session type — task, chat, mesh_*, blocker, run_repo. */
  session_type?: SessionType;
  /** Restrict to terminal status — e.g. `failed` to surface past mistakes. */
  status?: SessionStatus;
  /**
   * Narrow within the caller's tier-scope to a specific agent. The service
   * layer rejects ids outside scope.
   */
  agent_id?: string;
  /** Restrict to sessions tied to one task (task + its blocker + revisions). */
  task_id?: string;
  /** ISO-8601 lower bound on created_at. */
  since?: string;
  /** ISO-8601 upper bound on created_at. */
  until?: string;
}

// ── Request shapes (discriminated by `kind`) ──────────────────────────

export type SessionSearchRequest =
  | DiscoverRequest
  | ScrollRequest
  | ReadRequest
  | BrowseRequest;

export interface DiscoverRequest {
  kind: "discover";
  query: string;
  /** Max 10. Default 3. */
  limit?: number;
  /**
   * Temporal bias on top of FTS rank. `newest` for "where did we leave X",
   * `oldest` for "how did X start", omit for relevance-only.
   */
  sort?: "newest" | "oldest";
  filters?: SessionSearchFilters;
}

export interface ScrollRequest {
  kind: "scroll";
  session_id: string;
  /** Either a session_event.id, or `intent:<session_id>` for a user turn. */
  around_message_id: string;
  /** Clamped to [1, 20]. Default 5. */
  window?: number;
}

export interface ReadRequest {
  kind: "read";
  session_id: string;
}

export interface BrowseRequest {
  kind: "browse";
  /** Max 10. Default 5. */
  limit?: number;
  filters?: SessionSearchFilters;
}

// ── Session metadata preview (every shape returns this) ───────────────

export interface SessionMetaPreview {
  session_id: string;
  /** Head-of-chain id for chats; null for non-chat sessions. */
  conversation_id: string | null;
  type: SessionType;
  status: SessionStatus;
  agent_id: string;
  task_id: string | null;
  /** First ~200 chars of the head session's intent — the "goal" line. */
  intent_preview: string;
  created_at: string;
  completed_at: string | null;
  result_summary: string | null;
}

// ── Result shapes (discriminated by `kind`) ───────────────────────────

export interface DiscoverHit {
  session: SessionMetaPreview;
  /** Id of the message that scored the FTS hit. */
  match_message_id: string;
  matched_role: SessionSearchMsgKind;
  /** ts_headline excerpt with default `<b>...</b>` highlight markers. */
  snippet: string;
  /** First 3 user-or-agent turns of the lineage (the "goal" / kickoff). */
  bookend_start: SessionSearchMsg[];
  /** ±5 messages around the anchor, anchor itself flagged. */
  messages: SessionSearchMsg[];
  /** Last 3 user-or-agent turns of the lineage (the "resolution"). */
  bookend_end: SessionSearchMsg[];
  messages_before: number;
  messages_after: number;
}

export interface DiscoverResult {
  kind: "discover";
  query: string;
  hits: DiscoverHit[];
  /** How many distinct lineages we considered (pre-limit). */
  lineages_searched: number;
}

export interface ScrollResult {
  kind: "scroll";
  session: SessionMetaPreview;
  around_message_id: string;
  window: number;
  messages: SessionSearchMsg[];
  messages_before: number;
  messages_after: number;
}

export interface ReadResult {
  kind: "read";
  session: SessionMetaPreview;
  message_count: number;
  truncated: boolean;
  messages: SessionSearchMsg[];
}

export interface BrowseResult {
  kind: "browse";
  sessions: SessionMetaPreview[];
}

export type SessionSearchResult =
  | DiscoverResult
  | ScrollResult
  | ReadResult
  | BrowseResult;

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Lineage key = `conversation_id` for chats, `session.id` otherwise.
 * Used by the repo to dedupe discovery hits and by the service to skip
 * the caller's active lineage.
 */
export function lineageKey(session: {
  id: string;
  conversation_id: string | null;
}): string {
  return session.conversation_id ?? session.id;
}

/**
 * Stable synthetic id for the user-turn message synthesised from
 * {@link Session.intent}. Matches the parsing in
 * {@link parseUserMessageId}.
 */
export function userMessageId(sessionId: string): string {
  return `intent:${sessionId}`;
}

/**
 * Reverse of {@link userMessageId}. Returns the underlying session id
 * when the input is a user-turn marker, or null otherwise.
 */
export function parseUserMessageId(messageId: string): string | null {
  if (messageId.startsWith("intent:")) return messageId.slice("intent:".length);
  return null;
}
