-- M8.D promotion audit log.
--
-- FactPromoter (packages/core/src/services/memory/fact-promoter.ts) runs
-- after every session via MemoryAgent.onTaskComplete and decides whether a
-- fact bubbles up the scope hierarchy. Today the decision silently updates
-- memory_fact.scope (or skips when rejected). This table captures every
-- decision so the Promotions page can surface the LLM's reasoning.
--
-- A row is written for both promoted (scope changed) and rejected (kept
-- narrow) decisions. `from_scope` is nullable for forward-compat with a
-- future fact-creation event source; FactPromoter always writes a non-null
-- value since it operates on existing facts.

CREATE TABLE memory_promotion_event (
  id                   text PRIMARY KEY,
  fact_id              text NOT NULL REFERENCES memory_fact(id) ON DELETE CASCADE,
  from_scope           text NULL,
  to_scope             text NOT NULL,
  origin_agent_id      text NOT NULL REFERENCES agent(id),
  promoter_reason      text NOT NULL,
  source_session_ids   text[] NOT NULL DEFAULT '{}',
  rejected             boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_promotion_event_created
  ON memory_promotion_event(created_at DESC);
CREATE INDEX idx_promotion_event_agent
  ON memory_promotion_event(origin_agent_id);
CREATE INDEX idx_promotion_event_fact
  ON memory_promotion_event(fact_id);
