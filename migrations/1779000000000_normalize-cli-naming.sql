-- Daemon-first restructure / Phase 1: normalize CLI naming.
--
-- Today's `agent.runtime_config.type = 'claude-code'` is internal jargon.
-- The daemon spawner's CLI command is `claude` (the binary on PATH), and
-- exposing the same string in the runtime registry simplifies the daemon
-- protocol: claim payloads carry `cli: 'claude'`, the daemon shells out
-- to that exact name, no translation step.
--
-- Forward path (this PR): rename existing rows in-place.
-- Application code is updated in the same PR to register and emit "claude".
-- Future CLIs (codex, opencode) will land with their canonical binary name.

UPDATE agent
SET    runtime_config = jsonb_set(runtime_config, '{type}', '"claude"')
WHERE  runtime_config->>'type' = 'claude-code';
