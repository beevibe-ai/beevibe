-- Replace the alphabetical priority DESC index with a semantic CASE ordering
-- matching the executor's dispatch query. Alphabetical `priority DESC` on a
-- TEXT column orders low > high > critical — the opposite of intent.
--
-- The new index also covers status IN ('assigned', 'revision') so revision
-- tasks (re-queued after human feedback) share the dispatch path.

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
) WHERE status IN ('assigned', 'revision');
