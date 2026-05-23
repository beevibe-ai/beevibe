-- Link IC sub-sessions to the team session that spawned them, and push a
-- `session.spawned` SSE event so the chat UI can nest the IC's live
-- transcript inline under the team agent's create_task tool_call (instead
-- of forcing the user to navigate Tasks → Task → Session to see what a
-- delegated specialist is doing).
--
-- The existing `trg_session_notify` (1778300000000_add-sse-event-triggers.sql)
-- already emits `session.updated` for the CHILD row on insert. That event
-- is keyed on the child id, which the chat UI can't correlate with the
-- team-agent message that spawned the IC. This migration adds a SEPARATE
-- notify keyed on the PARENT session id with the child's metadata in the
-- payload, so the team session's stream gets a clear "I just spawned X"
-- signal.
--
-- Payload follows the bv_notify_session_step shape:
--   {event:'session.spawned', id:<parent_session_id>, data:{
--      child_session_id, agent_id, task_id, intent
--   }}
-- intent is truncated to 256 chars to stay well under Postgres's 8000-byte
-- NOTIFY cap, matching the precedent from bv_notify_session_step.

ALTER TABLE session
  ADD COLUMN parent_session_id TEXT REFERENCES session(id);

CREATE INDEX session_parent_session_id_idx
  ON session (parent_session_id)
  WHERE parent_session_id IS NOT NULL;

CREATE OR REPLACE FUNCTION bv_notify_session_spawned() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'bv_event',
    json_build_object(
      'event', 'session.spawned',
      'id', NEW.parent_session_id,
      'data', json_build_object(
        'child_session_id', NEW.id,
        'agent_id', NEW.agent_id,
        'task_id', NEW.task_id,
        'intent', LEFT(NEW.intent, 256)
      )
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_session_spawned_notify
  AFTER INSERT ON session
  FOR EACH ROW
  WHEN (NEW.parent_session_id IS NOT NULL)
  EXECUTE FUNCTION bv_notify_session_spawned();
