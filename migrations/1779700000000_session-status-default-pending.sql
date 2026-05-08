-- Phase 4 / M4.5c: re-flip session.status default to 'pending'.
--
-- 1779400000000 reverted the default to 'running' as a Phase 3 safety net
-- because the legacy executor's AgentSession.run created sessions without
-- an explicit status. Phase 4 makes every INSERT explicit:
--   - dispatchService passes status='pending' for all daemon/executor-
--     claimable rows.
--   - AgentSession.run passes status='running' for the inline mesh/chat
--     spawn path.
-- The default is now don't-care; setting it to 'pending' aligns the
-- column's most-likely value with reality (most new sessions go through
-- dispatchService).

ALTER TABLE session ALTER COLUMN status SET DEFAULT 'pending';
