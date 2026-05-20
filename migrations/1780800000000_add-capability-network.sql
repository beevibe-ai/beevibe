-- Capability Network MVP (#149).
--
-- Three layers persisted here:
--   1. repo_run        — one row per `use_repo` invocation; carries live
--                        transcript, exported artifact ids, status.
--   2. learned_skill   — a working (goal → repo → install → invocation)
--                        recipe captured from a successful repo_run.
--   3. skill_outcome   — human review verdict per learned_skill run,
--                        feeds back into the discovery ranker.
--
-- Artifacts themselves are written as ordinary work_product rows
-- (type='artifact') so they show up in the existing inbox/review UI.
-- The link from work_product → repo_run lives in work_product.metadata
-- (no new FK column on work_product — keeps the existing surface clean).

-- ── repo_run ───────────────────────────────────────────────────────────
CREATE TABLE repo_run (
  id              TEXT PRIMARY KEY,
  session_id      TEXT REFERENCES session(id) ON DELETE CASCADE,
  task_id         TEXT REFERENCES task(id) ON DELETE SET NULL,
  agent_id        TEXT NOT NULL REFERENCES agent(id),

  goal            TEXT NOT NULL,
  repo_url        TEXT NOT NULL,
  repo_ref        TEXT,
  -- 'pending'   — accepted, daemon hasn't started yet
  -- 'running'   — orchestrator is driving a child claude session
  -- 'succeeded' — at least one artifact exported, no fatal error
  -- 'failed'    — sandbox/claude/orchestrator error
  -- 'blocked'   — agent finished but exported nothing
  -- 'cancelled' — user-cancelled mid-run
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','succeeded','failed','blocked','cancelled')),
  transcript      JSONB NOT NULL DEFAULT '[]'::jsonb,
  install_log     TEXT,
  invocation      TEXT,
  error           TEXT,

  -- Set when the user captures this run as a reusable skill.
  -- Nullable; one row per origin run.
  learned_skill_id TEXT,

  -- When learned_skill_id was created from this run we may also
  -- record which discovered candidates were considered (debug).
  ranker_candidates JSONB,

  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ
);

CREATE INDEX idx_repo_run_agent      ON repo_run(agent_id, started_at DESC);
CREATE INDEX idx_repo_run_session    ON repo_run(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_repo_run_task       ON repo_run(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_repo_run_running    ON repo_run(status) WHERE status IN ('pending','running');

-- ── learned_skill ──────────────────────────────────────────────────────
CREATE TABLE learned_skill (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  goal_pattern    TEXT NOT NULL,
  repo_url        TEXT NOT NULL,
  repo_ref        TEXT NOT NULL,
  install_steps   TEXT NOT NULL,
  invocation      TEXT NOT NULL,

  source_run_id   TEXT REFERENCES repo_run(id) ON DELETE SET NULL,
  owner_id        TEXT NOT NULL REFERENCES person(id),

  -- NULL = local-only.
  -- 'community' once the publish flow has filed a PR against
  -- beevibe-ai/beevibe-capabilities (the PR URL goes in published_pr).
  published_to    TEXT
                    CHECK (published_to IS NULL OR published_to IN ('community')),
  published_pr    TEXT,
  published_at    TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (owner_id, name)
);

CREATE INDEX idx_learned_skill_owner ON learned_skill(owner_id, created_at DESC);

-- Full-text index on goal_pattern accelerates the discovery
-- ranker's "does any saved skill match this goal" lookup.
CREATE INDEX idx_learned_skill_goal_pattern
  ON learned_skill USING gin (to_tsvector('english', goal_pattern));

-- Back-fill the FK on repo_run now that learned_skill exists.
ALTER TABLE repo_run
  ADD CONSTRAINT repo_run_learned_skill_fk
  FOREIGN KEY (learned_skill_id) REFERENCES learned_skill(id) ON DELETE SET NULL;

-- ── skill_outcome ──────────────────────────────────────────────────────
CREATE TABLE skill_outcome (
  id                TEXT PRIMARY KEY,
  learned_skill_id  TEXT NOT NULL REFERENCES learned_skill(id) ON DELETE CASCADE,
  repo_run_id       TEXT NOT NULL REFERENCES repo_run(id) ON DELETE CASCADE,
  work_product_id   TEXT REFERENCES work_product(id) ON DELETE SET NULL,
  -- 'approved' — human approved the artifact
  -- 'revised'  — human asked for revision (counts as partial success)
  -- 'rejected' — human rejected the artifact (recipe broken or wrong fit)
  outcome           TEXT NOT NULL
                      CHECK (outcome IN ('approved','revised','rejected')),
  reviewer_id       TEXT REFERENCES person(id),
  recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A single (skill, run) pair has exactly one outcome row.
  UNIQUE (learned_skill_id, repo_run_id)
);

-- Discovery query: "last N outcomes for this skill, newest first".
CREATE INDEX idx_skill_outcome_lookup
  ON skill_outcome (learned_skill_id, recorded_at DESC);
