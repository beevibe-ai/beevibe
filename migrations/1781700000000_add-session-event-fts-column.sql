-- session_search Layer-3 substrate, part 2 of 3: tsvector column on the
-- big `session_event` table.
--
-- PRODUCTION CAVEAT — schedule this during a maintenance window if
-- session_event has accumulated significant transcript history.
--
-- This is a table rewrite: ALTER TABLE ADD COLUMN ... GENERATED ALWAYS
-- AS (...) STORED computes the value for every existing row and writes
-- it inline, holding an ACCESS EXCLUSIVE lock for the duration. On a
-- table with millions of rows this can take minutes and blocks every
-- read and write to session_event while running. There's no way to
-- avoid the rewrite for STORED generated columns; the operational fix
-- is timing the migration when load is low, not changing the design.
--
-- Generated only for kind='agent' rows — the partial index in part 3
-- (migration 1781800) skips NULL entries naturally, so non-agent rows
-- (tool_call, tool_result, summary) carry NULL in this column and
-- contribute zero index size.

ALTER TABLE session_event
  ADD COLUMN IF NOT EXISTS content_fts tsvector
  GENERATED ALWAYS AS (
    CASE WHEN kind = 'agent'
      THEN to_tsvector('english', coalesce(content, ''))
      ELSE NULL
    END
  ) STORED;
