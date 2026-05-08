-- Daemon-first restructure / Phase 1: session.runtime_id + spawn_mode +
-- last_event_at + 'pending' status.
--
-- Today's `session.status` defaults to 'running' and disallows 'pending':
-- the row only ever exists once a CLI subprocess has been spawned. With
-- daemons, the spawn is asynchronous — `dispatchService.dispatchTask`
-- INSERTs the row with status='pending' (immediate), then notifies the
-- daemon, which atomically claims and flips to 'running' some milliseconds
-- to seconds later. We need 'pending' as a first-class status so the
-- daemon's claim query has something to atomically transition.
--
-- runtime_id is set at INSERT time (NOT at claim time). For fresh sessions:
-- runtime_id = agent.preferred_runtime_id. For resume sessions (revision,
-- post-escalation, crash-recovery): runtime_id = prior_session.runtime_id —
-- this PINS the session to the same machine as the prior CLI run, because
-- Claude's `--resume` reads ~/.claude/projects/<…>/<cli_session_id>.jsonl
-- from local disk. NULL runtime_id is reserved for server_fallback_mesh.
--
-- spawn_mode discriminates daemon-claimed sessions from server-side mesh
-- fallback sessions (where the target's daemon is offline and the API
-- spawns a restricted-tool fallback CLI in /tmp). Restricted tool surface
-- assembly switches on this column.
--
-- last_event_at supports the orphan reaper: a session with status='running'
-- and last_event_at older than 90s + a runtime whose heartbeat is also
-- 90s+ stale is presumed dead and gets re-dispatched as crash_recovery.
-- App code (SessionEventRepository.append) updates this column inline on
-- each event INSERT — cheaper than a trigger and bounds the write fanout.

ALTER TABLE session DROP CONSTRAINT session_status_check;
ALTER TABLE session ADD CONSTRAINT session_status_check
  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled'));
ALTER TABLE session ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE session
  ADD COLUMN runtime_id    TEXT REFERENCES runtime(id),
  ADD COLUMN spawn_mode    TEXT NOT NULL DEFAULT 'daemon'
    CHECK (spawn_mode IN ('daemon', 'server_fallback_mesh')),
  ADD COLUMN last_event_at TIMESTAMPTZ;

-- Daemon claim query: "give me the next pending session for runtime R".
CREATE INDEX idx_session_pending_dispatch
  ON session(runtime_id, type, created_at)
  WHERE status = 'pending';

-- Orphan reaper: "running sessions whose last event is stale."
CREATE INDEX idx_session_orphan_reaper
  ON session(status, last_event_at)
  WHERE status = 'running';
