-- M8 final integration (#45 item 3a): persist the per-session briefing
-- structured snapshot.
--
-- MemoryAgent.prepareBriefing already composes <core_memory> +
-- <archival_memory> XML for the agent's system prompt; the structured
-- counterpart (block_count / fact_count / blocks[] / facts[]) is what
-- the session detail page needs. We persist the structured form as JSONB
-- so the view can return it without parsing XML.
--
-- Transcript persistence (the CLI subprocess stdio events) is deferred —
-- separate table + executor wiring; tracked in the follow-up issue.

ALTER TABLE session
  ADD COLUMN briefing JSONB NULL;
