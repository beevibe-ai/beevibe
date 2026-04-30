-- M6.3 — work_product.updated_at column for the update_work_product MCP tool
--
-- The agent's create_work_product tool inserts a row at session-end. The new
-- update_work_product tool (added in M6.3) lets agents amend a deliverable
-- (e.g., refresh a PR's summary after pushing more commits) without creating
-- duplicate rows. update_at is bumped on UPDATE; created_at remains the
-- original insertion timestamp.

ALTER TABLE work_product
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
