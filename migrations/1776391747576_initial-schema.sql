-- Up Migration

-- ── person (human users) ────────────────────────────────────────────────
CREATE TABLE person (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_person_email ON person(email) WHERE email IS NOT NULL;

-- ── agent (AI agents, hierarchy) ───────────────────────────────────────
CREATE TABLE agent (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  owner_id           TEXT NOT NULL REFERENCES person(id),
  parent_agent_id    TEXT REFERENCES agent(id),
  hierarchy_level    TEXT NOT NULL DEFAULT 'ic'
                       CHECK (hierarchy_level IN ('ic', 'team', 'org')),
  api_key            TEXT UNIQUE,
  review_policy      TEXT
                       CHECK (review_policy IS NULL OR review_policy IN ('require_human', 'auto_done')),
  runtime_config     JSONB NOT NULL
                       DEFAULT '{"type":"claude-code","model":"claude-opus-4-7"}'::jsonb,
  max_task_sessions  INTEGER,
  max_mesh_sessions  INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_owner   ON agent(owner_id);
CREATE INDEX idx_agent_parent  ON agent(parent_agent_id);
CREATE INDEX idx_agent_api_key ON agent(api_key) WHERE api_key IS NOT NULL;

-- ── task (work items) ──────────────────────────────────────────────────
CREATE TABLE task (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'assigned', 'in_progress', 'review',
                                        'revision', 'blocked', 'done', 'failed', 'cancelled')),
  priority          TEXT NOT NULL DEFAULT 'medium'
                      CHECK (priority IN ('low', 'medium', 'high', 'critical')),

  assignee_id       TEXT REFERENCES agent(id),
  creator_id        TEXT NOT NULL,
  creator_type      TEXT NOT NULL CHECK (creator_type IN ('person', 'agent')),
  parent_task_id    TEXT REFERENCES task(id),

  result_summary    TEXT,

  blocker_agent_id  TEXT REFERENCES agent(id),
  blocker_reason    TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_assignee_status ON task(assignee_id, status);
CREATE INDEX idx_task_status          ON task(status);
CREATE INDEX idx_task_parent          ON task(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX idx_task_creator         ON task(creator_id);
CREATE INDEX idx_task_dispatch        ON task(status, priority DESC, created_at ASC)
                                      WHERE status = 'assigned';

-- ── session (CLI invocations) ──────────────────────────────────────────
CREATE TABLE session (
  id                 TEXT PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES agent(id),
  task_id            TEXT REFERENCES task(id),
  prior_session_id   TEXT REFERENCES session(id),

  type               TEXT NOT NULL
                       CHECK (type IN ('task', 'mesh_ask', 'mesh_negotiate', 'blocker', 'chat')),
  status             TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  intent             TEXT NOT NULL,

  cli_session_id     TEXT,

  worktree_path      TEXT,
  branch_name        TEXT,

  process_pid        INTEGER,
  process_group_id   INTEGER,

  result_summary     TEXT,
  exit_code          INTEGER,
  error              TEXT,

  usage              JSONB,

  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_session_agent_status ON session(agent_id, status);
CREATE INDEX idx_session_task         ON session(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX idx_session_reap         ON session(status, type, process_pid)
                                      WHERE status = 'running' AND process_pid IS NOT NULL;
CREATE INDEX idx_session_created      ON session(created_at DESC);

-- ── core_memory_block (agent persona/knowledge blocks) ─────────────────
CREATE TABLE core_memory_block (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  block_name   TEXT NOT NULL,
  content      TEXT NOT NULL DEFAULT '',
  char_limit   INTEGER NOT NULL DEFAULT 2000,
  is_system    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (agent_id, block_name)
);

CREATE INDEX idx_cmb_agent ON core_memory_block(agent_id);

-- ── work_product (task outputs: PRs, docs, artifacts) ──────────────────
CREATE TABLE work_product (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL REFERENCES agent(id),
  type         TEXT NOT NULL
                 CHECK (type IN ('pull_request', 'branch', 'commit', 'document',
                                 'analysis', 'report', 'design', 'artifact', 'preview')),
  title        TEXT NOT NULL,
  summary      TEXT,
  url          TEXT,
  provider     TEXT,
  external_id  TEXT,
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wp_task  ON work_product(task_id);
CREATE INDEX idx_wp_agent ON work_product(agent_id);

-- ── memory_fact (archival facts with pgvector embeddings) ──────────────
CREATE TABLE memory_fact (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
  scope             TEXT NOT NULL CHECK (scope IN ('ic', 'team', 'org')),
  fact_type         TEXT NOT NULL
                      CHECK (fact_type IN ('belief', 'pattern', 'gotcha', 'preference', 'decision')),
  content           TEXT NOT NULL,
  embedding         VECTOR(1536) NOT NULL,
  source_chain_ids  TEXT[] DEFAULT '{}',
  confidence        REAL NOT NULL DEFAULT 1.0,
  valid_from        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tags              TEXT[] DEFAULT '{}',
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memory_fact_agent_scope ON memory_fact(agent_id, scope);
CREATE INDEX idx_memory_fact_hnsw        ON memory_fact USING hnsw (embedding vector_cosine_ops);


-- Down Migration
DROP TABLE IF EXISTS memory_fact;
DROP TABLE IF EXISTS work_product;
DROP TABLE IF EXISTS core_memory_block;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS task;
DROP TABLE IF EXISTS agent;
DROP TABLE IF EXISTS person;
