-- Per-run list of secret NAMES (not values) the caller asked use_repo to
-- inject into the sandbox container as env vars.
--
-- We persist names only because the dispatch path is:
--   use_repo MCP handler (api)           [validates secret names exist]
--     → INSERT session + repo_run rows
--     → daemon polls /runtime/claim
--     → composeDispatchPayload reads repo_run
--     → looks up + decrypts named person_secret rows
--     → puts decrypted values into DispatchPayload.run_repo.sandbox_env
--     → daemon spawns docker run --env NAME=VALUE
--
-- The decryption happens at /runtime/claim time, so decrypted values
-- never land in the DB. If a user deletes a secret between the
-- use_repo call and the daemon's claim, that secret is silently
-- omitted from the env (graceful degradation: the run can still try
-- with whatever IS configured).

ALTER TABLE repo_run
  ADD COLUMN requested_secret_names TEXT[];
