-- Rooms — multi-tenant collaboration spaces.
--
-- A `room` has multiple human participants AND multiple agent
-- participants. From a participant's POV: humans can post plain
-- messages to each other (no LLM call), or @mention an agent to
-- invoke it. Agents who are co-members of any room can `ask` each
-- other via mesh — the peer-tree check is relaxed for co-members.
--
-- Sessions spawned inside a room carry `session.room_id` so the
-- SSE fanout layer can deliver their events to every room member's
-- browser, not just the agent owner's.
--
-- Schema is intentionally minimal: no roles, no archive flag, no
-- "private/public" distinction. Anyone in a room can invite anyone
-- else; anyone can post. Trust model is "we know each other" —
-- governance comes later if/when we sell into orgs.

CREATE TABLE room (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_person_id TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_room_owner ON room(owner_person_id);

-- One row per (room, participant). `kind` discriminates between
-- human and agent participants; exactly one of person_id / agent_id
-- is set. CHECK enforces this.
-- Postgres doesn't allow expressions in PRIMARY KEY, so use a synthetic
-- `subject_id` (always = COALESCE(person_id, agent_id)) for uniqueness.
-- Trigger fills it on INSERT so callers don't need to know.
CREATE TABLE room_member (
  room_id    TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('person', 'agent')),
  person_id  TEXT REFERENCES person(id) ON DELETE CASCADE,
  agent_id   TEXT REFERENCES agent(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, subject_id),
  CHECK (
    (kind = 'person' AND person_id IS NOT NULL AND agent_id IS NULL AND subject_id = person_id) OR
    (kind = 'agent'  AND agent_id  IS NOT NULL AND person_id IS NULL AND subject_id = agent_id)
  )
);

CREATE INDEX idx_room_member_person ON room_member(person_id) WHERE kind = 'person';
CREATE INDEX idx_room_member_agent  ON room_member(agent_id)  WHERE kind = 'agent';

-- Messages in a room. Two flavors:
--   - kind='human': sender_person_id set, content is plain text
--   - kind='agent': sender_agent_id set, content is the agent's
--     final visible response (post-directive-stripping). session_id
--     points at the AgentSession that produced this turn so the UI
--     can deep-link to the transcript.
CREATE TABLE room_message (
  id                 TEXT PRIMARY KEY,
  room_id            TEXT NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
  sender_person_id   TEXT REFERENCES person(id),
  sender_agent_id    TEXT REFERENCES agent(id),
  content            TEXT NOT NULL,
  session_id         TEXT REFERENCES session(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (kind = 'human' AND sender_person_id IS NOT NULL AND sender_agent_id IS NULL) OR
    (kind = 'agent' AND sender_agent_id  IS NOT NULL AND sender_person_id IS NULL)
  )
);

CREATE INDEX idx_room_message_room_time ON room_message(room_id, created_at);

-- Sessions get a nullable room_id so AgentSession.run can stamp it
-- when the turn was kicked off from a room. SSE fanout uses this to
-- deliver events to every room_member, not just the owning person.
ALTER TABLE session ADD COLUMN room_id TEXT REFERENCES room(id);
CREATE INDEX idx_session_room ON session(room_id) WHERE room_id IS NOT NULL;

-- Notify on room_message INSERT so the chat surface invalidates
-- live. Same payload shape as other bv_event triggers; the OwnerLookup
-- helper resolves owners for room messages by walking room_id →
-- room_member.person_id.
CREATE OR REPLACE FUNCTION bv_notify_room_message() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'bv_event',
    json_build_object(
      'event', 'room.message',
      'id', NEW.room_id
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_room_message_notify
  AFTER INSERT ON room_message
  FOR EACH ROW EXECUTE FUNCTION bv_notify_room_message();
