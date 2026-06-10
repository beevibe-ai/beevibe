-- session_search Layer-3 substrate, part 1 of 3: tsvector + GIN for the
-- small `session` table.
--
-- This migration affects only the `session` table, which is small in every
-- realistic deployment (one row per CLI invocation; not the big transcript
-- table). ALTER TABLE ADD COLUMN ... GENERATED STORED rewrites every row,
-- but the cost is negligible here.
--
-- The big-table half (session_event) is split into 1781700 (column add,
-- still rewrites the table — schedule a maintenance window) and 1781800
-- (CREATE INDEX CONCURRENTLY, lockless, runs outside transaction).
--
-- See Hermes Agent's session_search for the indexing strategy
-- (https://github.com/NousResearch/hermes-agent/blob/main/tools/session_search_tool.py).
-- We index intent (user turns) and assistant turns only — not tool I/O —
-- because tool output (file dumps, JSON blobs) is mostly noise in snippets
-- and would bloat the index.

ALTER TABLE session
  ADD COLUMN IF NOT EXISTS intent_fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(intent, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_session_intent_fts
  ON session USING GIN (intent_fts);
