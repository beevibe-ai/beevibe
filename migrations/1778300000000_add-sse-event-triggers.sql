-- M8 final integration (#45 item 1): pg_notify triggers feeding the SSE
-- live-update flow.
--
-- One channel `bv_event` with payload `{event: '<name>', id: '<row id>'}` —
-- the api server's SseListener picks these up and fans out to subscribed
-- browsers; the web's `useLiveUpdates` hook invalidates React Query caches
-- by event name (see `packages/web/lib/sse.ts:eventInvalidations`).
--
-- Payload is intentionally minimal (just event + id) so each notify stays
-- well under Postgres's 8000-byte payload limit. The browser re-fetches
-- the affected query via the existing GET endpoints, which are already
-- owner-scoped.
--
-- v1 does not filter notifies by owner — events are fanned out to all
-- listeners and React Query simply invalidates owner-scoped queries on
-- the browser side. Cross-owner activity timing/IDs leak to other
-- listeners; acceptable for self-hosted single-user. Multi-tenant would
-- need owner-aware filtering; tracked in the issue.

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

CREATE TRIGGER trg_task_notify
  AFTER INSERT OR UPDATE ON task
  FOR EACH ROW EXECUTE FUNCTION bv_notify_event();

CREATE TRIGGER trg_agent_notify
  AFTER UPDATE ON agent
  FOR EACH ROW EXECUTE FUNCTION bv_notify_event();

CREATE TRIGGER trg_session_notify
  AFTER INSERT OR UPDATE ON session
  FOR EACH ROW EXECUTE FUNCTION bv_notify_event();

CREATE TRIGGER trg_memory_fact_notify
  AFTER INSERT ON memory_fact
  FOR EACH ROW EXECUTE FUNCTION bv_notify_event();

CREATE TRIGGER trg_promotion_event_notify
  AFTER INSERT ON memory_promotion_event
  FOR EACH ROW EXECUTE FUNCTION bv_notify_event();

CREATE TRIGGER trg_negotiation_notify
  AFTER INSERT OR UPDATE ON negotiation
  FOR EACH ROW EXECUTE FUNCTION bv_notify_event();
