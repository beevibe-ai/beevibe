-- Two production fixes for the watch_tasks wake path.
--
-- 1. Inherit `runtime_id` on the wake session row.
--
--    The original trigger inserted the wake with runtime_id unset (NULL).
--    Chat conversations are runtime-pinned: every session in a chain
--    inherits the head's runtime_id so the same daemon picks up every
--    turn (the CLI session file lives on the user's machine — only THAT
--    daemon can claude --resume it). A NULL runtime_id is the
--    server-fallback signal; the scheduler's worker poll claimed wakes
--    and tried to run claude in the server process, which failed with
--    no useful error → chat history rendered the "Couldn't reach your
--    team agent" pointer. Inheriting waiter_rec.runtime_id routes the
--    wake to the user's daemon as the rest of the chain already does.
--
-- 2. Wrap the wake intent in `<system-wake>...</system-wake>`.
--
--    chainToMessages pushes every session's intent as a user bubble.
--    Without a marker, the system-generated wake message appears in
--    chat as if the user had typed it. The wrap lets chainToMessages
--    skip the user-bubble push for wake turns while leaving the agent's
--    reply visible. The wrapped tag is also what the agent sees via
--    claude --resume — it's a clear "this came from the system" cue,
--    similar to <mesh-ask> and <mesh-blocker>.

CREATE OR REPLACE FUNCTION bv_build_watch_intent(
  p_watch_id        TEXT,
  p_firing_task_id  TEXT
) RETURNS TEXT AS $$
DECLARE
  w               RECORD;
  firing_task     RECORD;
  body            TEXT;
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

    body := reason_prefix
            || cardinality(w.task_ids)::text || ' tasks completed:' || E'\n'
            || COALESCE(task_list, '') || E'\n'
            || 'Decide next steps.';
  ELSE
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

    body := reason_prefix
            || 'Task '
            || COALESCE(firing_task.title, '(untitled)')
            || ' — ' || firing_task.status
            || bv_task_result_suffix(firing_task.status, firing_task.result_summary)
            || E'\n';

    IF others_count > 0 THEN
      body := body
              || 'Other watched tasks still running:' || E'\n'
              || others_list || E'\n';
    END IF;

    body := body || 'Decide next steps.';
  END IF;

  -- Wrap so chainToMessages can detect the system-generated turn and
  -- avoid rendering it as a user bubble. The agent reads the content
  -- between the tags via --resume; the wrapper is a small "this came
  -- from the system" cue rather than an instruction.
  RETURN '<system-wake>' || E'\n' || body || E'\n' || '</system-wake>';
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
  FOR watch_rec IN
    SELECT * FROM task_watch
     WHERE status = 'waiting'
       AND task_ids @> ARRAY[NEW.id]
     FOR UPDATE
  LOOP
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

    SELECT * FROM session WHERE id = watch_rec.waiter_session_id
      INTO waiter_rec;
    wake_intent := bv_build_watch_intent(watch_rec.id, NEW.id);
    new_session_id := 'sess_' ||
      substring(replace(gen_random_uuid()::text, '-', ''), 1, 12);

    INSERT INTO session (
      id, agent_id, task_id, prior_session_id,
      type, status, intent, conversation_id,
      runtime_id
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
      END,
      waiter_rec.runtime_id
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
