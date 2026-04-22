-- Up Migration

-- Session table: under the sandbox workspace model (M2), branches are
-- agent-owned and the path we care about is the agent's workspace dir,
-- not a platform-managed worktree. Rename the path column and drop the
-- branch column — the agent tracks its own branches.
ALTER TABLE session RENAME COLUMN worktree_path TO workspace_path;
ALTER TABLE session DROP COLUMN branch_name;

-- Task table: add structured repo hint so the executor can deterministically
-- inject repo context into the agent briefing. Nullable — non-repo tasks
-- (research, meta-work) don't need it. Agents fall back to parsing
-- task.description when repo_url is null.
ALTER TABLE task ADD COLUMN repo_url TEXT;


-- Down Migration
ALTER TABLE task DROP COLUMN repo_url;
ALTER TABLE session ADD COLUMN branch_name TEXT;
ALTER TABLE session RENAME COLUMN workspace_path TO worktree_path;
