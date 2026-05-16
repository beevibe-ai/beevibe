-- Partial index for the `active_sessions` rollup on /agent list.
--
-- The query in `packages/api/src/views/agents.ts` is:
--   COUNT(*) FILTER (WHERE status = 'running')
-- grouped by agent_id. Running sessions are a small subset of all
-- sessions, so a partial index keyed on agent_id over only the
-- running subset is both tiny and ideal for the FILTER predicate —
-- Postgres can satisfy the active-count via an index-only scan
-- without touching the full session heap.
--
-- The existing `idx_session_agent_status` covers the (agent_id, status)
-- pair but isn't partial; this index complements it without overlap.

CREATE INDEX IF NOT EXISTS idx_session_agent_running
  ON session(agent_id)
  WHERE status = 'running';
