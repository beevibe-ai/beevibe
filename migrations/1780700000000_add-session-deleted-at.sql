-- session.deleted_at marks a chat conversation as soft-deleted by the
-- caller. The chat conversation list and history queries hide rows
-- where deleted_at IS NOT NULL; the row stays in the table for audit
-- and so foreign-key references (mesh asks, work products, runtime
-- ownership) keep resolving.
--
-- Soft-delete applies to whole chains: when a user deletes a
-- conversation we mark every session in the chain (head + ancestors
-- via prior_session_id) so the conversation can't reappear under a
-- different head id.

ALTER TABLE session
  ADD COLUMN deleted_at TIMESTAMPTZ NULL;

-- Partial index: list queries always filter `deleted_at IS NULL`, so
-- the index only needs to cover live rows. Same shape as idx_agent_active.
CREATE INDEX idx_session_chat_active
  ON session(agent_id, created_at DESC)
  WHERE type = 'chat' AND deleted_at IS NULL;
