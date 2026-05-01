-- M8.B dashboard view indexes.
--
-- The KPI_TREND_SQL and TREND_SQL queries in `packages/api/src/views/dashboard.ts`
-- filter by `(status, updated_at)` and `(status, completed_at|started_at)` over
-- 7-14 day windows. The existing `idx_task_status` and `idx_session_agent_status`
-- cover the status leg only; without composite indexes on the timestamp legs,
-- Postgres scans all rows matching the status before filtering by date.
--
-- For dashboard payload latency at workspace scale (10K+ tasks / sessions),
-- the cost of these indexes is paid back by every home-page render.

CREATE INDEX IF NOT EXISTS idx_task_status_updated
  ON task(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_status_started
  ON session(status, started_at DESC)
  WHERE started_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_status_completed
  ON session(status, completed_at DESC)
  WHERE completed_at IS NOT NULL;
