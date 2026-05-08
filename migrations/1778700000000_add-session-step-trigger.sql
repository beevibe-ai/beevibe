-- Stream agent transcript steps over the existing SSE channel.
--
-- Every `session_event` INSERT now fires a `session.step` notification on
-- `bv_event` so the browser-side chat UI can render tool calls in real
-- time (instead of just showing a 5-30s spinner). Payload is the same
-- {event,id,data} shape the rest of the SSE flow uses, with `data`
-- carrying the step's kind/tool_name and a content preview.
--
-- Why a separate function (not bv_notify_event):
--   - bv_notify_event sends only {event,id}; step events need a `data`
--     field with the step itself
--   - content is truncated server-side to 512 chars to stay well under
--     Postgres's 8000-byte NOTIFY payload cap

CREATE OR REPLACE FUNCTION bv_notify_session_step() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'bv_event',
    json_build_object(
      'event', 'session.step',
      'id', NEW.session_id,
      'data', json_build_object(
        'event_id', NEW.id,
        'kind', NEW.kind,
        'tool_name', NEW.tool_name,
        'content', LEFT(NEW.content, 512)
      )
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_session_event_step_notify
  AFTER INSERT ON session_event
  FOR EACH ROW EXECUTE FUNCTION bv_notify_session_step();
