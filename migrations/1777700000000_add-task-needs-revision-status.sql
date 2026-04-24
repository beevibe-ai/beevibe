-- Split `revision` into two states to preserve semantic clarity between
-- "re-work is queued" and "re-work is currently running":
--
--   needs_revision  (new)  — human requested re-work; waiting for dispatch.
--                            This is what listAssignable + claimById match.
--   revision        (was "queue state"; now "running state")
--                          — re-work is currently executing. Set by claimById
--                            as the post-claim status for a `needs_revision`
--                            task. Dispatch reads this to pass priorSessionId
--                            (→ --resume on the Claude CLI).
--
-- Atomic claim continues to rely on the row's status transition: claim
-- changes needs_revision → revision, so the row no longer matches
-- listAssignable's predicate and cannot be double-claimed.

ALTER TABLE task DROP CONSTRAINT IF EXISTS task_status_check;
ALTER TABLE task ADD CONSTRAINT task_status_check
  CHECK (status IN (
    'pending',
    'assigned',
    'in_progress',
    'needs_revision',
    'revision',
    'review',
    'blocked',
    'done',
    'failed',
    'cancelled'
  ));

-- Dispatch index predicate must follow listAssignable / claimById.
DROP INDEX IF EXISTS idx_task_dispatch;

CREATE INDEX idx_task_dispatch ON task (
  (CASE priority
     WHEN 'critical' THEN 4
     WHEN 'high'     THEN 3
     WHEN 'medium'   THEN 2
     WHEN 'low'      THEN 1
     ELSE 0
   END) DESC,
  created_at ASC
) WHERE status IN ('assigned', 'needs_revision');
