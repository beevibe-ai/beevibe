-- Replace the SQL-regex `substring(intent FROM 'from="([^"]+)"')` extraction
-- in views/mesh.ts with a real column on session. The regex worked but
-- defeats indexes — for the activity feed + mesh graph it means a sequential
-- scan of every running mesh_ask / blocker session every render.
--
-- caller_agent_id is set on INSERT for mesh_ask / mesh_negotiate / blocker
-- session types (the spawning code knows the caller from request context).
-- Existing rows backfill from the same regex the view used so no transcript
-- is lost.

ALTER TABLE session
  ADD COLUMN caller_agent_id TEXT REFERENCES agent(id);

CREATE INDEX idx_session_caller_agent
  ON session(caller_agent_id)
  WHERE caller_agent_id IS NOT NULL;

-- One-shot backfill for the rows that currently encode the caller in
-- their intent XML.
UPDATE session
   SET caller_agent_id = substring(intent FROM 'from="([^"]+)"')
 WHERE type IN ('mesh_ask', 'blocker', 'mesh_negotiate')
   AND intent LIKE '%from="%';
