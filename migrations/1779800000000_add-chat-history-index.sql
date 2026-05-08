-- Covering index for `SessionRepository.listChatForAgent` (PR #58 +
-- daemon-first restructure).
--
-- The chat history endpoints filter by (agent_id, type='chat') and
-- order by created_at DESC with a hard LIMIT. Without this index the
-- planner index-scans `idx_session_agent_status` (which excludes
-- created_at), pulls every chat row for the agent, then sorts. For a
-- heavy user with 10K chat sessions that's a 10K-row sort per page
-- load — defeats the bounded LIMIT.
--
-- Partial: only chat sessions are indexed, keeping the index small
-- (mesh / task sessions stay on the general agent_status index).

CREATE INDEX IF NOT EXISTS idx_session_agent_chat_created
  ON session(agent_id, created_at DESC)
  WHERE type = 'chat';
