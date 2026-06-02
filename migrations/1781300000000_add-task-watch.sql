-- task_watch — team agent declares "wake me when these dispatched tasks
-- finish" before ending its session. The next migration (M2) attaches
-- the AFTER-UPDATE trigger on `task` that fans matching watches into
-- new sessions; this migration only lands the table + indexes so the
-- repo + adapter are testable on their own.
--
-- waiter_session_id  — the session that called watch_tasks. The wake
--                      session chains off this via prior_session_id so
--                      claude --resume restores full agent context.
-- agent_id           — denormalized waiter session's agent for
--                      cheap auth checks at unwatch time.
-- mode               — 'all' (every task terminal) | 'any' (first one).
-- task_ids           — non-empty array of task ids the agent is waiting
--                      on. GIN-indexed (partial on waiting rows) so the
--                      M2 trigger can locate candidates quickly.
-- status             — 'waiting' until the trigger fires or the agent
--                      calls unwatch. Terminal states: 'fired' (wake
--                      session inserted) | 'aborted' (agent cancelled).
-- fired_session_id   — the wake session inserted by the trigger; set
--                      atomically alongside status='fired'.

CREATE TABLE task_watch (
  id                text PRIMARY KEY,
  waiter_session_id text NOT NULL REFERENCES session(id),
  agent_id          text NOT NULL REFERENCES agent(id),
  mode              text NOT NULL CHECK (mode IN ('all', 'any')),
  task_ids          text[] NOT NULL CHECK (cardinality(task_ids) > 0),
  reason            text,
  status            text NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting', 'fired', 'aborted')),
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  fired_at          timestamptz,
  fired_session_id  text REFERENCES session(id)
);

CREATE INDEX task_watch_waiting_idx
  ON task_watch (status)
  WHERE status = 'waiting';

CREATE INDEX task_watch_task_ids_waiting_idx
  ON task_watch USING GIN (task_ids)
  WHERE status = 'waiting';

CREATE INDEX task_watch_waiter_session_idx
  ON task_watch (waiter_session_id);
