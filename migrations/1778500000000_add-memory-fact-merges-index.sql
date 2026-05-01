-- M8 final integration (#45 item 4): partial index for the agent-detail
-- merges count.
--
-- `views/agents.ts:DETAIL_SQL_DELTA_METRICS` filters memory_fact by
-- `agent_id = $1 AND array_length(source_session_ids, 1) >= 2` to count
-- "merged" facts. Without this index, agents with many facts (1000+) trigger
-- a sequential scan on every detail page render.
--
-- Partial index keeps the index footprint tight — single-source facts (the
-- common case) aren't included.

CREATE INDEX IF NOT EXISTS idx_memory_fact_agent_merges
  ON memory_fact(agent_id)
  WHERE array_length(source_session_ids, 1) >= 2;
