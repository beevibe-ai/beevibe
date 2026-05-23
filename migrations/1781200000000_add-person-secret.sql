-- Per-person encrypted secret store, used to inject env vars (API keys,
-- tokens) into sandboxed `use_repo` runs.
--
-- Motivation: today's sandbox spawns docker with NO --env flags, so a
-- repo like @beevibe/architecture-deep-research (needs OPENAI_API_KEY +
-- a search-provider key to call cloud APIs) fundamentally cannot run
-- via use_repo. The capability network was built for offline tools
-- (yt-dlp / ffmpeg / pdf parsing). Adding a secret store + injection
-- path unblocks cloud-API-using repos.
--
-- Encryption: AES-256-GCM, master key from BEEVIBE_SECRETS_KEY env
-- (32-byte hex). Each row stores its own IV + auth tag — the key never
-- lives in the DB. value_encrypted is the ciphertext only; never the
-- plaintext. Decryption happens server-side in the api process; the
-- decrypted value is threaded to the daemon in the dispatch payload and
-- to the docker container via `docker run --env`, but is never returned
-- to any client and never logged in session_event content.
--
-- Auth model v1: person-scoped, implicit. Any of a person's agents can
-- request any of their secrets in a use_repo call. Per-agent / per-repo
-- grants are a follow-up. Org-scoped shared secrets are also a follow-up.

CREATE TABLE person_secret (
  id              TEXT PRIMARY KEY,
  person_id       TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  -- Env-var-style name. Convention: SCREAMING_SNAKE_CASE. We don't
  -- enforce a regex at the DB level — the API route validates shape
  -- so an existing row's name can still be read even if we tighten
  -- the rules later.
  name            TEXT NOT NULL,
  -- AES-256-GCM ciphertext (hex). value_iv + value_tag are the per-row
  -- nonce + auth tag, both hex-encoded. value_iv is 12 bytes (24 hex
  -- chars), value_tag is 16 bytes (32 hex chars).
  value_encrypted TEXT NOT NULL,
  value_iv        TEXT NOT NULL,
  value_tag       TEXT NOT NULL,
  -- Optional one-line description shown in the settings UI ("Used by
  -- ADR specialist for deep research runs"). Never sent to the
  -- sandbox; this is metadata for the human.
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (person_id, name)
);

CREATE INDEX person_secret_person_id_idx ON person_secret (person_id);
