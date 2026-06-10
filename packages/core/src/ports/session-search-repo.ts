import type {
  BrowseRequest,
  BrowseResult,
  DiscoverRequest,
  DiscoverResult,
  ReadRequest,
  ReadResult,
  ScrollRequest,
  ScrollResult,
} from "../domain/session-search.js";

/**
 * Resolved scope passed into every repo call. The service layer derives
 * this from the caller's hierarchy_level and applies the owner boundary
 * before any query reaches the DB.
 */
export interface SessionSearchScope {
  /**
   * The agent_ids the caller may search across. Always non-empty when
   * the caller is alive. The repo applies this as `session.agent_id =
   * ANY($agent_ids)` — no fallback to "search everything".
   */
  agent_ids: string[];
  /**
   * Lineage keys to exclude. Populated with the caller's own active
   * conversation/session so discovery doesn't re-surface messages the
   * caller already has in context.
   */
  exclude_lineage_keys: string[];
}

/**
 * Repo contract — pure data access, no scope resolution, no policy.
 *
 * Each method runs the SQL for one calling shape against the FTS-indexed
 * substrate (see migration 1781600000000). Returns null when the caller
 * referenced an id outside the resolved scope (read/scroll only); the
 * service translates this to a `not_found_or_forbidden` tool error.
 */
export interface SessionSearchRepository {
  /**
   * FTS5-equivalent discovery. Dedupes hits by lineage_key. Returns up
   * to `req.limit` (clamped to [1, 10], default 3) hits, each with
   * bookend_start + ±5 message window + bookend_end.
   */
  discover(req: DiscoverRequest, scope: SessionSearchScope): Promise<DiscoverResult>;

  /**
   * Window of ±`window` messages centered on `around_message_id` inside
   * the lineage of `session_id`. Returns null if the session is outside
   * scope or the message id doesn't resolve.
   */
  scroll(req: ScrollRequest, scope: SessionSearchScope): Promise<ScrollResult | null>;

  /**
   * Whole-session dump (head + tail when large). Returns null if the
   * session is outside scope.
   */
  read(req: ReadRequest, scope: SessionSearchScope): Promise<ReadResult | null>;

  /**
   * Recent sessions chronologically. No FTS, no message bodies — just
   * metadata previews. Honors filters + exclude_lineage_keys.
   */
  browse(req: BrowseRequest, scope: SessionSearchScope): Promise<BrowseResult>;
}
