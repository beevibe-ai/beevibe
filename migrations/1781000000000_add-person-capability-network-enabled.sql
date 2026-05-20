-- Capability Network feature flag (#153).
--
-- Per-user opt-out switch: when FALSE, the UI hides /capabilities and
-- the API filters find_repo + use_repo out of the tool list returned
-- by /mcp's assembleTools. Default TRUE so existing users see the
-- feature on next refresh; rollback path is one toggle in /settings.
ALTER TABLE person
  ADD COLUMN capability_network_enabled BOOLEAN NOT NULL DEFAULT TRUE;
