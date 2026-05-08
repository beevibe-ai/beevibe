-- Phase 3 follow-up: index daemon.token_hash so authentication doesn't
-- seq-scan the daemon table on every request. Phase 4's daemon endpoints
-- (/runtime/claim, /runtime/heartbeat, /runtime/events, /runtime/done)
-- all hit this lookup path. Partial-unique because revoked daemons
-- shouldn't collide with active ones for the same token reuse case.

CREATE UNIQUE INDEX daemon_token_hash_active_idx
  ON daemon(token_hash) WHERE revoked_at IS NULL;
