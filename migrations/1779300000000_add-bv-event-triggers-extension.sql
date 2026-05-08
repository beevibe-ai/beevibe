-- Extends the bv_notify_event() function (initially defined in
-- migration 1778300000000) to fire on two more table sources:
--
--   runtime       → 'runtime.updated' on INSERT and UPDATE OF last_heartbeat.
--                   UPDATE is narrowed to the heartbeat column so unrelated
--                   updates (cli_version bumps) don't spam the SSE bus.
--
--   session_event → 'session.event' on INSERT, payload {event,id=session_id}.
--                   Drives a re-fetch path; the inline-data 'session.step'
--                   notify (migration 1778700000000) runs in parallel for
--                   optimistic streaming.

CREATE OR REPLACE FUNCTION bv_notify_event() RETURNS trigger AS $$
DECLARE
  event_name text;
  row_id text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    row_id := NEW.id;
  ELSE
    row_id := COALESCE(NEW.id, OLD.id);
  END IF;

  IF TG_TABLE_NAME = 'task' THEN
    event_name := CASE WHEN TG_OP = 'INSERT' THEN 'task.created' ELSE 'task.updated' END;
  ELSIF TG_TABLE_NAME = 'agent' THEN
    event_name := 'agent.updated';
  ELSIF TG_TABLE_NAME = 'session' THEN
    event_name := 'session.updated';
  ELSIF TG_TABLE_NAME = 'memory_fact' THEN
    event_name := 'memory.fact.created';
  ELSIF TG_TABLE_NAME = 'memory_promotion_event' THEN
    event_name := 'promotion.created';
  ELSIF TG_TABLE_NAME = 'negotiation' THEN
    event_name := 'mesh.activity';
  ELSIF TG_TABLE_NAME = 'runtime' THEN
    event_name := 'runtime.updated';
  ELSIF TG_TABLE_NAME = 'session_event' THEN
    event_name := 'session.event';
    -- For session_event we want the SSE consumer (chat UI) to re-fetch by
    -- session_id, not by the event row id.
    row_id := COALESCE(NEW.session_id, OLD.session_id);
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  PERFORM pg_notify(
    'bv_event',
    json_build_object('event', event_name, 'id', row_id)::text
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- New triggers. INSERT covers fresh registrations; UPDATE OF last_heartbeat
-- covers online/offline transitions and 30s heartbeat refreshes (cheap).
CREATE TRIGGER trg_runtime_insert_notify
  AFTER INSERT ON runtime
  FOR EACH ROW EXECUTE FUNCTION bv_notify_event();

CREATE TRIGGER trg_runtime_heartbeat_notify
  AFTER UPDATE OF last_heartbeat ON runtime
  FOR EACH ROW EXECUTE FUNCTION bv_notify_event();

CREATE TRIGGER trg_session_event_notify
  AFTER INSERT ON session_event
  FOR EACH ROW EXECUTE FUNCTION bv_notify_event();
