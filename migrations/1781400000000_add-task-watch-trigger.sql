-- M2 of the watch_tasks feature: trigger that fans terminal task
-- transitions into wake sessions. The waiting `task_watch` row is the
-- agent's explicit "wake me when these finish" subscription; this
-- trigger fires on the matching task UPDATE, builds an intent message
-- describing what completed, inserts a new pending session that
-- continues the waiter's chain via prior_session_id, and stamps the
-- watch row 'fired' with the new session id — all in the same
-- transaction as the task status change.
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
-- bv_build_watch_intent is split out so the M3 service-layer
-- already-terminal race can call it for symmetry. Same text either way.

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
  firing_suffix   TEXT;
BEGIN
  SELECT * INTO w FROM task_watch WHERE id = p_watch_id;

  IF w.mode = 'all' THEN
    SELECT string_agg(
      format(
        '  - %s — %s%s',
        COALESCE(t.title, '(untitled)'),
        t.status,
        CASE
          WHEN t.status = 'done' AND COALESCE(t.result_summary, '') <> '' THEN
            '. Result: ' || t.result_summary
          WHEN t.status = 'failed' AND COALESCE(t.result_summary, '') <> '' THEN
            ': ' || t.result_summary
          ELSE ''
        END
      ),
      E'\n'
      ORDER BY t.created_at
    )
    INTO task_list
    FROM task t
    WHERE t.id = ANY(w.task_ids);

    intent := cardinality(w.task_ids)::text || ' tasks completed:' || E'\n'
              || COALESCE(task_list, '') || E'\n'
              || 'Decide next steps.';
  ELSE
    -- mode='any'
    SELECT * INTO firing_task FROM task WHERE id = p_firing_task_id;

    firing_suffix := CASE
      WHEN firing_task.status = 'done' AND COALESCE(firing_task.result_summary, '') <> '' THEN
        '. Result: ' || firing_task.result_summary
      WHEN firing_task.status = 'failed' AND COALESCE(firing_task.result_summary, '') <> '' THEN
        ': ' || firing_task.result_summary
      ELSE ''
    END;

    SELECT string_agg(
      format('  - %s — %s', COALESCE(t.title, '(untitled)'), t.status),
      E'\n'
      ORDER BY t.created_at
    ), COUNT(*)
    INTO others_list, others_count
    FROM task t
    WHERE t.id = ANY(w.task_ids)
      AND t.id <> p_firing_task_id;

    intent := 'Task '
              || COALESCE(firing_task.title, '(untitled)')
              || ' — ' || firing_task.status
              || firing_suffix
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
  -- Iterate every WAITING watch that references this task.
  -- `FOR UPDATE` so two concurrent task UPDATEs touching the same
  -- watch can't both fire it (the loser sees status='fired' or waits
  -- for the winner to commit).
  FOR watch_rec IN
    SELECT * FROM task_watch
     WHERE status = 'waiting'
       AND NEW.id = ANY(task_ids)
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
