-- Adds a `memory.fact.deleted` SSE event source so the web's memory
-- list view refreshes after a user-driven delete (fix D from issue
-- #90). The existing `memory.fact.created` event only fires on INSERT;
-- DELETE goes through silently and the UI doesn't know to drop the row
-- from its cached query.
--
-- Extends bv_notify_event() (defined in 1778300000000, extended in
-- 1779300000000) with a TG_OP-aware memory_fact branch, plus a new
-- AFTER DELETE trigger.

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
    event_name := CASE WHEN TG_OP = 'INSERT' THEN 'memory.fact.created' ELSE 'memory.fact.deleted' END;
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

CREATE TRIGGER trg_memory_fact_delete_notify
  AFTER DELETE ON memory_fact
  FOR EACH ROW EXECUTE FUNCTION bv_notify_event();
