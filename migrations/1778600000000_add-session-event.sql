-- M8 demo prep / #47: persist session transcript events.
--
-- The session detail page's `transcript` was an empty array. The executor's
-- AgentSession.run already streams CLI events through the runtime's
-- onStep callback; we now append each one to this table so the page can
-- replay the agent's thinking + tool calls + tool results.
--
-- Designed for high write rate: bulk inserts during a session, no fancy
-- triggers, append-only. Cleanup on session deletion via FK cascade.

CREATE TABLE session_event (
  id          text PRIMARY KEY,
  session_id  text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  kind        text NOT NULL,                    -- 'agent' | 'tool_call' | 'tool_result' | 'summary'
  content     text NOT NULL,
  tool_name   text NULL,                        -- only set for tool_call / tool_result
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_event_session
  ON session_event(session_id, created_at);
