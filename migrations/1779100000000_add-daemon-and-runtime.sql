-- Daemon-first restructure / Phase 1: daemon + runtime tables.
--
-- The daemon is the long-running process on a user's machine that registers,
-- claims pending sessions, spawns the CLI, and streams events back. We model
-- it in two normalized tables, mirroring Multica's pattern:
--
--   daemon  — one row per user machine; carries the bv_d_<id> auth token
--             (hashed) and the human-readable device_name shown in the
--             "Settings → Runtimes" panel.
--
--   runtime — one row per (daemon, CLI) pair. A single daemon detects N
--             CLIs on PATH (claude, codex, opencode, …) and registers one
--             runtime per detected CLI. Agents bind to a runtime by
--             matching their `runtime_config.type` against `runtime.cli`.
--             Multiple agents using the same CLI on the same machine
--             share one runtime row.
--
-- last_heartbeat lives on `runtime` (per-CLI liveness) so the panel UI can
-- show per-CLI online status when a daemon supports several. The daemon
-- emits one heartbeat per registered runtime each tick.
--
-- ON DELETE CASCADE from daemon → runtime: revoking a daemon revokes all
-- its runtimes. ON DELETE SET NULL from runtime → agent.preferred_runtime_id:
-- losing a runtime unbinds agents but doesn't delete them.
--
-- IDs are TEXT (prefixed nanoids: `dmn_…`, `rt_…`) to match the
-- existing typed-id convention in this schema (agent_*, sess_*, task_*).

CREATE TABLE daemon (
  id              TEXT PRIMARY KEY,
  owner_person_id TEXT NOT NULL REFERENCES person(id),

  external_id     TEXT NOT NULL,                  -- daemon-chosen stable id, persisted in ~/.beevibe/config.json
  device_name     TEXT NOT NULL,                  -- "ZhePang's MacBook Pro"

  token_hash      TEXT NOT NULL,                  -- argon2 hash of the bv_d_<id> daemon token
  last_seen_at    TIMESTAMPTZ,                    -- last successful auth (heartbeat or claim)

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,                    -- soft delete; preserves audit trail

  UNIQUE (owner_person_id, external_id)
);

CREATE INDEX daemon_owner_active_idx
  ON daemon(owner_person_id) WHERE revoked_at IS NULL;

CREATE TABLE runtime (
  id              TEXT PRIMARY KEY,
  daemon_id       TEXT NOT NULL REFERENCES daemon(id) ON DELETE CASCADE,

  cli             TEXT NOT NULL,                  -- 'claude' | 'codex' | 'opencode' | ...
  cli_version     TEXT,                           -- "1.x.y" — surfaced in panel UI

  last_heartbeat  TIMESTAMPTZ,                    -- per-runtime liveness; daemon sends one per tick per runtime
  capabilities    JSONB NOT NULL DEFAULT '{}',    -- room for future per-runtime metadata

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (daemon_id, cli)
);

CREATE INDEX runtime_cli_health_idx
  ON runtime(cli, last_heartbeat);                -- "any online claude runtime for this user?"

ALTER TABLE agent
  ADD COLUMN preferred_runtime_id TEXT REFERENCES runtime(id) ON DELETE SET NULL;

CREATE INDEX agent_runtime_idx
  ON agent(preferred_runtime_id) WHERE preferred_runtime_id IS NOT NULL;
