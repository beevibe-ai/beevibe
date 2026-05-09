-- Phase 9: audit log + soft archive for create_subordinate_agent.
--
-- agent_provision_event records every subordinate spawn. Used by:
--   1. Audit / debugging: who spawned which child + with what
--      persona+domain briefing, when?
--   2. Per-parent daily cap: count rows in last 24h to rate-limit a
--      runaway parent spawning specialists nonstop. Cap is enforced
--      in the create_subordinate_agent tool handler — DB just stores.
--
-- agent.archived_at is the soft-archive marker. Web list views hide
-- archived agents by default; row stays for audit / mesh history.

CREATE TABLE agent_provision_event (
  id              TEXT PRIMARY KEY,
  parent_agent_id TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  child_agent_id  TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  /* The acting human (parent's owner_id at spawn time). Frozen even if
     ownership transfers later. */
  owner_person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  child_name      TEXT NOT NULL,
  persona         TEXT NOT NULL,
  domain          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_provision_parent_time
  ON agent_provision_event(parent_agent_id, created_at DESC);

CREATE INDEX idx_agent_provision_owner_time
  ON agent_provision_event(owner_person_id, created_at DESC);

ALTER TABLE agent
  ADD COLUMN archived_at TIMESTAMPTZ NULL;

CREATE INDEX idx_agent_active
  ON agent(owner_id)
  WHERE archived_at IS NULL;
