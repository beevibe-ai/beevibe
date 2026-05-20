-- Add the 'run_repo' session type for Capability Network repo-run dispatches.
--
-- A `use_repo` invocation creates a session row of this type as its dispatch
-- vehicle. The daemon claims it like any other session, branches in the
-- spawner to invoke @beevibe/sandbox's runRepoAgent instead of the CLI
-- runtime, and posts transcript events through the existing
-- /runtime/events pipeline (which writes to session_event).

ALTER TABLE session DROP CONSTRAINT IF EXISTS session_type_check;
ALTER TABLE session ADD CONSTRAINT session_type_check
  CHECK (type IN ('task', 'mesh_ask', 'mesh_negotiate', 'blocker', 'chat', 'run_repo'));
