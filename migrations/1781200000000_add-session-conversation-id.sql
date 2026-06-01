-- Materialize the chat-conversation thread identifier as a column.
--
-- Today the chat history endpoint groups chat turns into conversation
-- chains by walking `prior_session_id` backwards in JS
-- (see `groupIntoConversations` in packages/api/src/routes/chat.ts).
-- That works for one bounded list but doesn't compose: the agent detail
-- "recent sessions" view can't collapse chat turns into one card per
-- thread without re-running the walk, and the dashboard's "active
-- sessions" metric oscillates between turns because each turn is its own
-- short-lived `running` row.
--
-- Stamping the head id directly onto every row in a chain lets:
--   - the agents view GROUP BY conversation_id with a single SQL query;
--   - the dashboard filter to `type != 'chat'` while still treating a
--     multi-turn conversation as a meaningful entity elsewhere;
--   - the chat surface drop the JS walk in favor of an indexed lookup.
--
-- For chat sessions: `conversation_id` is the id of the first turn in
-- the thread; subsequent turns inherit it via the INSERT SQL in
-- packages/core/src/adapters/postgres/session-repo.ts. NULL for non-chat
-- sessions — task/mesh/blocker/run_repo aren't part of a conversation
-- thread.

ALTER TABLE session
  ADD COLUMN conversation_id TEXT;

-- Backfill: walk each chat session's prior_session_id chain back to the
-- head and stamp conversation_id = head_id.
--
-- Base case: chat sessions whose prior_session_id is null OR points
-- outside the chat type (data-integrity tolerance — should not happen
-- in practice, but mirrors groupIntoConversations's "pointer outside
-- input window → this row is its own head" behaviour).
--
-- Inductive case: chat sessions whose prior is also chat inherit the
-- prior's head_id. The `depth` column is a defensive cycle guard;
-- `prior_session_id` should only point backward in time but
-- groupIntoConversations already defends against corrupted chains and
-- this migration must not loop if production data has any.
WITH RECURSIVE heads(id, head_id, depth) AS (
  SELECT s.id, s.id, 0
    FROM session s
   WHERE s.type = 'chat'
     AND (
       s.prior_session_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM session p
          WHERE p.id = s.prior_session_id
            AND p.type = 'chat'
       )
     )
  UNION ALL
  SELECT child.id, h.head_id, h.depth + 1
    FROM session child
    JOIN heads h ON child.prior_session_id = h.id
   WHERE child.type = 'chat'
     AND h.depth < 1000
)
UPDATE session
   SET conversation_id = h.head_id
  FROM heads h
 WHERE session.id = h.id;

-- Defensive fallback: any chat row whose conversation_id is still NULL
-- after the recursive walk is a member of a chat-only cycle in
-- prior_session_id (data corruption — chains should only point backward
-- in time). The recursive CTE skips cycles because neither node
-- qualifies for the base case (each has a chat prior), and the
-- inductive step never seeds them. Without this fallback the cycle
-- members vanish from DETAIL_SQL_RECENT_CHAT_THREADS (which filters
-- `conversation_id IS NOT NULL`); groupIntoConversations in JS would
-- have surfaced them via its visited-set bail. Stamping each survivor
-- as its own thread head matches that JS contract.
UPDATE session
   SET conversation_id = id
 WHERE type = 'chat'
   AND conversation_id IS NULL;

-- Partial index for the agent detail "recent chat threads" rollup
-- (GROUP BY conversation_id WHERE agent_id=$1 AND type='chat') and the
-- planned chat history lookup that will replace the JS walk. Restricting
-- to chat rows with a populated conversation_id keeps the index small —
-- task/mesh sessions stay on `idx_session_agent_status` / the other
-- general indexes.
CREATE INDEX IF NOT EXISTS idx_session_agent_conversation
  ON session(agent_id, conversation_id, created_at DESC)
  WHERE type = 'chat' AND conversation_id IS NOT NULL;
