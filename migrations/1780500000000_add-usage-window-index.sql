-- Partial index for USAGE_WINDOW_SQL (dashboard usage rollup).
--
-- The query in `packages/api/src/views/dashboard.ts` is:
--   WHERE s.usage IS NOT NULL
--     AND s.completed_at >= NOW() - make_interval(days => $1::int * 2)
--
-- Existing `idx_session_status_completed` is keyed on (status, completed_at)
-- so it doesn't apply — the usage query has no status predicate (succeeded,
-- failed, and even some cancelled sessions can have usage attached).
--
-- The partial index narrows to rows that have telemetry, which is the
-- only set the dashboard cares about; on workspaces where most sessions
-- predate M9.8 (no usage column populated) this also keeps the index
-- compact.

CREATE INDEX IF NOT EXISTS idx_session_usage_completed
  ON session(completed_at DESC)
  WHERE usage IS NOT NULL;
