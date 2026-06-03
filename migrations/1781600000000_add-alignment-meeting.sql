-- Alignment Meeting — a live meeting between an owner and their team agent to
-- keep specialists aligned and fix memory drift.
--
-- The problem: each specialist agent (core_memory_block + memory_fact rows,
-- all agent_id-scoped) piles up beliefs/blocks over time. A human can't audit
-- those walls of text line by line, so a teammate quietly drifts — e.g. starts
-- believing memory is shared when beevibe's design is self-contained per-agent.
--
-- The meeting fixes this in three moves:
--   1. PREP  — a local model (ollama/gemma) reads each subordinate's memory and
--              distills a plain-language digest (believes/knows/working_on/rules).
--              Captured per-meeting in alignment_digest.
--   2. MEET  — the owner talks to the team agent (Claude) in a live chat session
--              (alignment_meeting.chat_session_id). Drift is spotted in
--              conversation; there is no automatic baseline comparison.
--   3. ACT   — confirmed corrections become alignment_action_item rows that
--              write back into the specialist's memory (status -> 'applied').
--
-- Mirrors the audit-table conventions of agent_provision_event /
-- memory_promotion_event: TEXT ids, FK ON DELETE CASCADE, TIMESTAMPTZ NOW().

CREATE TABLE alignment_meeting (
  id              TEXT PRIMARY KEY,
  /* The team/org agent whose specialists this meeting reviews. */
  team_agent_id   TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  /* The acting human (team agent's owner at meeting time). */
  owner_person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'prepping'
                    CHECK (status IN ('prepping', 'active', 'wrapped')),
  /* The live chat session that drives the conversation. Null until the first
     message is sent. Reuses the existing chat dispatch + resolver path. */
  chat_session_id TEXT REFERENCES session(id),
  /* Meeting notes — markdown, accrued as decisions land. */
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  wrapped_at      TIMESTAMPTZ NULL
);

CREATE INDEX idx_alignment_meeting_team_time
  ON alignment_meeting(team_agent_id, created_at DESC);
CREATE INDEX idx_alignment_meeting_owner_time
  ON alignment_meeting(owner_person_id, created_at DESC);

-- One row per specialist, captured at prep time. `summary` is gemma's
-- plain-language card; source_*_ids record exactly which memory was read so
-- the digest is traceable back to the raw blocks/facts.
CREATE TABLE alignment_digest (
  id               TEXT PRIMARY KEY,
  meeting_id       TEXT NOT NULL REFERENCES alignment_meeting(id) ON DELETE CASCADE,
  agent_id         TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  /* { believes: string[], knows: string[], working_on: string[], rules: string[] } */
  summary          JSONB NOT NULL,
  source_block_ids TEXT[] NOT NULL DEFAULT '{}',
  source_fact_ids  TEXT[] NOT NULL DEFAULT '{}',
  /* Model tag that produced this digest, e.g. "gemma3:4b". */
  model            TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alignment_digest_meeting ON alignment_digest(meeting_id);

-- The "action UI": each correction / note / follow-up the owner confirms in
-- the meeting. `correct_memory` items carry a target_ref describing the exact
-- write-back; applying one runs through CoreMemory / FactStore and stamps
-- applied_session_id + applied_at.
CREATE TABLE alignment_action_item (
  id                 TEXT PRIMARY KEY,
  meeting_id         TEXT NOT NULL REFERENCES alignment_meeting(id) ON DELETE CASCADE,
  /* The specialist this item corrects / concerns. */
  agent_id           TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL
                       CHECK (kind IN ('correct_memory', 'note', 'followup')),
  /* Plain-language headline, e.g. "Fix Dana: memory is self-contained". */
  title              TEXT NOT NULL,
  rationale          TEXT NOT NULL DEFAULT '',
  /* For kind='correct_memory': how to write back. One of:
       { type:'core_block', block_name, operation, content, old_content? }
       { type:'fact', fact_id?, content, fact_type? }
     Null for note / followup items. */
  target_ref         JSONB NULL,
  status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'applied', 'dismissed')),
  /* Audit marker for who/what applied the write-back: the meeting's chat
     session id when the team agent applied it in conversation, or a "manual:"
     marker for owner-driven applies from the web. Plain text (not a session
     FK) so manual applies without a live session are allowed. */
  applied_session_id TEXT,
  applied_at         TIMESTAMPTZ NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alignment_action_meeting ON alignment_action_item(meeting_id);
CREATE INDEX idx_alignment_action_agent ON alignment_action_item(agent_id);
