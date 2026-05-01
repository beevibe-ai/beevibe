-- M8.C mesh view indexes.
--
-- The ASKS_SQL, NODES_SQL, EDGES_SQL, and SUMMARY_SQL queries in
-- `packages/api/src/views/mesh.ts` filter
--   WHERE created_at >= NOW() - INTERVAL '24 hours' OR status = 'active'
-- and the existing indexes only cover (initiator_agent_id) and (task_id) —
-- no leg of that filter is indexed. For workspaces with thousands of
-- historical negotiations, the mesh page would scan the whole table.
--
-- Composite (status, created_at) serves both filter directions reasonably:
--   - status='active' → uses leading column directly
--   - created_at >= ... → bitmap-or with the same index
--
-- Matches the pattern set by 1778000000000_add-dashboard-indexes.sql.

CREATE INDEX IF NOT EXISTS idx_negotiation_status_created
  ON negotiation(status, created_at DESC);
