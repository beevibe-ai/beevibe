-- SUPERSEDED in part by 1781500000000_fix-task-watch-wake-runtime-and-marker.sql,
-- which CREATE OR REPLACEs both functions below to (a) inherit runtime_id
-- onto the wake session row and (b) wrap the intent in <system-wake>...
-- </system-wake>. This file is the deployed shape kept for historical record;
-- tune the superseding file when changing the trigger.

-- Trigger that fans terminal task transitions into wake sessions.
-- A waiting `task_watch` row is an agent's explicit "wake me when these
-- finish" subscription; this trigger fires on the matching task UPDATE,
-- builds an intent message describing what completed, inserts a new
-- pending session that continues the waiter's chain via prior_session_id,
-- and stamps the watch row 'fired' with the new session id — all in the
-- same transaction as the task status change.
--
-- Why a trigger and not the api layer:
--   - Wakes survive api restarts (mesh's in-memory resolvers don't).
--   - Atomic with the task UPDATE — no half-state where the task is
--     terminal but the wake hasn't landed.
--   - Works for any path that flips task.status (api routes,
--     update_progress, dispatch retry, manual psql).
--
-- Intent shapes match the plan's wake templates:
--   mode='all' fires only when every task in task_ids reaches a
--     terminal status (done | failed | cancelled). Intent lists each
--     task with its outcome.
--   mode='any' fires on the first terminal task; intent leads with
--     the firing task and lists the others as still-running context.
--
-- `bv_build_watch_intent` is split out so the service-layer
-- already-terminal path can call it for symmetry. Same text either way.

-- Per-task one-line suffix shared by both modes — keeps the result/error
-- formatting in one place.
CREATE OR REPLACE FUNCTION bv_task_result_suffix(
  p_status   TEXT,
  p_summary  TEXT
) RETURNS TEXT AS $$
BEGIN
  IF p_status = 'done' AND COALESCE(p_summary, '') <> '' THEN
    RETURN '. Result: ' || p_summary;
  ELSIF p_status = 'failed' AND COALESCE(p_summary, '') <> '' THEN
    RETURN ': ' || p_summary;
  ELSE
    RETURN '';
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- Build the wake-session intent for a watch + the task that just fired
-- it. Caller is expected to be inside a fire-eligible state machine
-- (trigger or service); the function itself doesn't validate.
CREATE OR REPLACE FUNCTION bv_build_watch_intent(
  p_watch_id        TEXT,
  p_firing_task_id  TEXT
) RETURNS TEXT AS $$
DECLARE
  w               RECORD;
  firing_task     RECORD;
  intent          TEXT;
  task_list       TEXT;
  others_list     TEXT;
  others_count    INT;
  reason_prefix   TEXT;
BEGIN
  SELECT * INTO w FROM task_watch WHERE id = p_watch_id;

  reason_prefix := CASE
    WHEN COALESCE(w.reason, '') <> '' THEN 'Wake reason: ' || w.reason || E'\n\n'
    ELSE ''
  END;

  IF w.mode = 'all' THEN
    SELECT string_agg(
      format(
        '  - %s — %s%s',
        COALESCE(t.title, '(untitled)'),
        t.status,
        bv_task_result_suffix(t.status, t.result_summary)
      ),
      E'\n'
      ORDER BY t.created_at
    )
    INTO task_list
    FROM task t
    WHERE t.id = ANY(w.task_ids);

    intent := reason_prefix
              || cardinality(w.task_ids)::text || ' tasks completed:' || E'\n'
              || COALESCE(task_list, '') || E'\n'
              || 'Decide next steps.';
  ELSE
    -- mode='any'
    SELECT * INTO firing_task FROM task WHERE id = p_firing_task_id;

    SELECT string_agg(
      format('  - %s — %s', COALESCE(t.title, '(untitled)'), t.status),
      E'\n'
      ORDER BY t.created_at
    ), COUNT(*)
    INTO others_list, others_count
    FROM task t
    WHERE t.id = ANY(w.task_ids)
      AND t.id <> p_firing_task_id;

    intent := reason_prefix
              || 'Task '
              || COALESCE(firing_task.title, '(untitled)')
              || ' — ' || firing_task.status
              || bv_task_result_suffix(firing_task.status, firing_task.result_summary)
              || E'\n';

    IF others_count > 0 THEN
      intent := intent
                || 'Other watched tasks still running:' || E'\n'
                || others_list || E'\n';
    END IF;

    intent := intent || 'Decide next steps.';
  END IF;

  RETURN intent;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION bv_check_task_watches() RETURNS trigger AS $$
DECLARE
  watch_rec      RECORD;
  waiter_rec     RECORD;
  all_terminal   BOOL;
  new_session_id TEXT;
  wake_intent    TEXT;
BEGIN
  -- Iterate every WAITING watch that references this task. The
  -- `task_ids @> ARRAY[NEW.id]` form (vs `NEW.id = ANY(task_ids)`) is
  -- what Postgres plans against the partial GIN on `task_ids` defined
  -- in the earlier migration. `FOR UPDATE` so two concurrent task
  -- UPDATEs touching the same watch can't both fire it.
  FOR watch_rec IN
    SELECT * FROM task_watch
     WHERE status = 'waiting'
       AND task_ids @> ARRAY[NEW.id]
     FOR UPDATE
  LOOP
    -- mode='all': fire only when every watched task is terminal.
    IF watch_rec.mode = 'all' THEN
      SELECT NOT EXISTS (
        SELECT 1 FROM task
         WHERE id = ANY(watch_rec.task_ids)
           AND status NOT IN ('done', 'failed', 'cancelled')
      ) INTO all_terminal;

      IF NOT all_terminal THEN
        CONTINUE;
      END IF;
    END IF;
    -- mode='any' always fires on the first terminal child.

    SELECT * FROM session WHERE id = watch_rec.waiter_session_id
      INTO waiter_rec;
    wake_intent := bv_build_watch_intent(watch_rec.id, NEW.id);
    new_session_id := 'sess_' ||
      substring(replace(gen_random_uuid()::text, '-', ''), 1, 12);

    INSERT INTO session (
      id, agent_id, task_id, prior_session_id,
      type, status, intent, conversation_id
    ) VALUES (
      new_session_id,
      waiter_rec.agent_id,
      waiter_rec.task_id,
      waiter_rec.id,
      waiter_rec.type,
      'pending',
      wake_intent,
      CASE
        WHEN waiter_rec.type = 'chat' THEN COALESCE(
          waiter_rec.conversation_id,
          waiter_rec.id
        )
        ELSE NULL
      END
    );

    UPDATE task_watch
       SET status = 'fired',
           fired_at = NOW(),
           fired_session_id = new_session_id
     WHERE id = watch_rec.id;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


CREATE TRIGGER trg_task_watch_check
  AFTER UPDATE ON task
  FOR EACH ROW
  WHEN (NEW.status IN ('done', 'failed', 'cancelled')
        AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION bv_check_task_watches();
