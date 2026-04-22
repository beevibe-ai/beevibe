-- Up Migration

-- M3 pre-release trim of memory_fact: drop unused fields and rename source_chain_ids
-- to source_session_ids. The old trace-chain concept is gone; we track session
-- provenance directly because post-session promotion (M3) queries facts by session id
-- across the executor/MCP-server process boundary.
--
-- confidence, valid_from, tags, metadata are dropped as unused in M3's agent-driven
-- memory design. No caller populates them or reads them.

ALTER TABLE memory_fact
  DROP COLUMN confidence,
  DROP COLUMN valid_from,
  DROP COLUMN tags,
  DROP COLUMN metadata;

ALTER TABLE memory_fact RENAME COLUMN source_chain_ids TO source_session_ids;


-- Down Migration

ALTER TABLE memory_fact RENAME COLUMN source_session_ids TO source_chain_ids;

ALTER TABLE memory_fact
  ADD COLUMN metadata   JSONB,
  ADD COLUMN tags       TEXT[] DEFAULT '{}',
  ADD COLUMN valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
