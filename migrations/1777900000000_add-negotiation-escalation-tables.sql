-- M6.4 — negotiation + escalation domain
--
-- Three new tables and two new columns supporting the agent-to-agent
-- negotiation flow and human-resolved escalations:
--
--   negotiation       one row per negotiation conversation
--   negotiation_round one row per back-and-forth message
--   escalation        one row per stuck negotiation handed off to a human
--
--   agent.max_negotiation_rounds  per-agent cap (default 5 in code)
--   task.next_dispatch_context    JSONB context for the next executor dispatch
--                                 (revision feedback / post-escalation resolution)
--
-- The B-resident negotiation model means counterparty_session_id is single
-- on the negotiation row (B is one session across all rounds). Per-round
-- detail lives on negotiation_round.

-- ── agent.max_negotiation_rounds ───────────────────────────────────────
ALTER TABLE agent
  ADD COLUMN max_negotiation_rounds INT;

-- ── task.next_dispatch_context ─────────────────────────────────────────
-- Set by reviseTask (M6.4) and EscalationService.resolve (M6.4); read by
-- executor's dispatch.ts (M6.5) to derive ResumeReason and pin priorSessionId.
-- Cleared implicitly when the task reaches terminal status (next dispatch
-- never happens). Monotonic-on-set: re-dispatches from crash retries see
-- the same context.
ALTER TABLE task
  ADD COLUMN next_dispatch_context JSONB;

-- ── negotiation ────────────────────────────────────────────────────────
CREATE TABLE negotiation (
  id                      TEXT PRIMARY KEY,
  initiator_agent_id      TEXT NOT NULL REFERENCES agent(id),
  initiator_session_id    TEXT NOT NULL REFERENCES session(id),
  counterparty_agent_id   TEXT NOT NULL REFERENCES agent(id),
  counterparty_session_id TEXT REFERENCES session(id),
  task_id                 TEXT REFERENCES task(id),

  max_rounds              INT  NOT NULL,
  rounds_completed        INT  NOT NULL DEFAULT 0,

  status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'accepted', 'rejected',
                                              'escalated', 'cancelled')),

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_negotiation_active ON negotiation(status) WHERE status = 'active';
CREATE INDEX idx_negotiation_task   ON negotiation(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_negotiation_initiator ON negotiation(initiator_agent_id);

-- ── negotiation_round ──────────────────────────────────────────────────
CREATE TABLE negotiation_round (
  id              TEXT PRIMARY KEY,
  negotiation_id  TEXT NOT NULL REFERENCES negotiation(id) ON DELETE CASCADE,
  round_number    INT  NOT NULL,
  from_agent_id   TEXT NOT NULL REFERENCES agent(id),
  decision        TEXT NOT NULL
                    CHECK (decision IN ('propose', 'counter', 'accept', 'reject')),
  message         TEXT NOT NULL,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(negotiation_id, round_number)
);

-- ── escalation ─────────────────────────────────────────────────────────
CREATE TABLE escalation (
  id                              TEXT PRIMARY KEY,
  negotiation_id                  TEXT NOT NULL UNIQUE REFERENCES negotiation(id),

  initiator_session_id            TEXT NOT NULL REFERENCES session(id),
  counterparty_session_id         TEXT NOT NULL REFERENCES session(id),

  -- Single shared problem statement, set on first call (escalate_to_humans).
  -- Immutable thereafter; the second party uses add_to_escalation which
  -- doesn't accept a summary arg.
  summary                         TEXT NOT NULL,

  -- Each side's contributions populated independently. Slot determined by
  -- caller's role on the underlying negotiation.
  initiator_proposals             JSONB,
  initiator_open_questions        TEXT[] NOT NULL DEFAULT '{}',
  initiator_submitted_at          TIMESTAMPTZ,

  counterparty_proposals          JSONB,
  counterparty_open_questions     TEXT[] NOT NULL DEFAULT '{}',
  counterparty_submitted_at       TIMESTAMPTZ,

  -- Audit: which role escalated first (for "1 of 2 received" UI hints).
  escalated_by_role               TEXT NOT NULL
                                    CHECK (escalated_by_role IN ('initiator','counterparty')),

  status                          TEXT NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'resolved', 'cancelled')),
  resolution_proposal             JSONB,
  resolution_notes                TEXT,
  resolved_by                     TEXT REFERENCES person(id),
  resolved_at                     TIMESTAMPTZ,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT resolution_required CHECK (
    status != 'resolved' OR resolution_proposal IS NOT NULL
  )
);

CREATE INDEX idx_escalation_pending      ON escalation(status, created_at) WHERE status = 'pending';
CREATE INDEX idx_escalation_negotiation  ON escalation(negotiation_id);
