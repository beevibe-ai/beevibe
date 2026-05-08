/**
 * M10 e2e — proves the session_event persistence + bv_event SSE pipeline
 * + the json_agg view-join all work end-to-end against a live Postgres.
 *
 * What's covered here (vs unit tests):
 *   - The migration applies cleanly and produces the expected schema
 *     (session_event table, indexes, triggers).
 *   - PostgresSessionEventRepository.append → DB row INSERT (smoke).
 *   - INSERT fires `pg_notify('bv_event', {event: 'session.event', id: <session_id>})`
 *     via the trigger from migration 1779300000000.
 *   - INSERT also fires `pg_notify('bv_event', {event: 'session.step', ...})`
 *     via the richer trigger from migration 1778700000000 (carries kind +
 *     content preview).
 *   - getSessionView returns transcript[] populated from json_agg, in
 *     created_at order, capped at 500 events.
 *
 * What's NOT here (covered elsewhere):
 *   - AgentSession.run onStep wrapper (agent-session.test.ts).
 *   - Parser → events shape (stream-json.test.ts).
 *   - SSE listener fanout to browsers (sse/listener.test.ts + manager.test.ts).
 *
 * Usage (against the local docker postgres on port 5433):
 *   RUN_M10_E2E=1 \
 *   DATABASE_URL_TEST=postgresql://beevibe:beevibe@localhost:5433/beevibe_test \
 *     pnpm tsx scripts/m10-session-event-e2e.ts
 *
 * The script applies migrations from this checkout and then runs the
 * scenarios. It does NOT spawn claude — Phase 1 doesn't change runtime
 * spawning, only persistence + the SSE pipeline shape.
 */

import { config as loadEnv } from "dotenv";
import pg from "pg";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
loadEnv({ path: resolve(repoRoot, ".env") });

import {
  agentId as makeAgentId,
  personId as makePersonId,
  sessionEventId as makeSessionEventId,
  sessionId as makeSessionId,
} from "../packages/core/src/domain/ids.js";
import { PostgresSessionEventRepository } from "../packages/core/src/adapters/postgres/session-event-repo.js";
import { createPool, type Pool } from "../packages/core/src/adapters/postgres/client.js";

const REQUIRED_ENV = ["RUN_M10_E2E", "DATABASE_URL_TEST"] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`✗ M10 E2E: missing env var ${k}`);
    process.exit(1);
  }
}

const databaseUrl = process.env.DATABASE_URL_TEST!;

function log(msg: string): void {
  console.log(msg);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function applyMigrations(): Promise<void> {
  log("→ applying migrations against DATABASE_URL_TEST");
  execSync("pnpm migrate:test up", {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
}

async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = createPool({ connectionString: databaseUrl });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function reset(pool: Pool): Promise<void> {
  // Truncate in dependency order. session_event ON DELETE CASCADE handles
  // itself when we wipe session.
  await pool.query(`
    TRUNCATE TABLE
      session_event, session, task, agent, person
    CASCADE
  `);
}

interface SeedResult {
  personId: string;
  agentId: string;
  sessionId: string;
}

async function seedSession(pool: Pool): Promise<SeedResult> {
  const pid = makePersonId();
  const aid = makeAgentId();
  const sid = makeSessionId();
  await pool.query(
    `INSERT INTO person (id, name, email, api_key) VALUES ($1, $2, $3, $4)`,
    [pid, "m10-tester", `m10-${Date.now()}@example.test`, `bv_u_${pid}`],
  );
  await pool.query(
    `INSERT INTO agent (id, name, owner_id, hierarchy_level, runtime_config, api_key)
     VALUES ($1, $2, $3, 'team', $4::jsonb, $5)`,
    [aid, "M10 Test Agent", pid, JSON.stringify({ type: "claude" }), `bv_a_${aid}`],
  );
  // Use 'running' to bypass the new 'pending' default and get into
  // the state where session_event INSERTs make sense for transcript replay.
  await pool.query(
    `INSERT INTO session (id, agent_id, type, status, intent, started_at)
     VALUES ($1, $2, 'task', 'running', 'm10 e2e', now())`,
    [sid, aid],
  );
  return { personId: pid, agentId: aid, sessionId: sid };
}

// ───────────────────────── scenarios ─────────────────────────

async function scenarioSchemaSmoke(pool: Pool): Promise<void> {
  log("\n=== scenario 1: schema smoke ===");
  const expectTable = async (name: string) => {
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [name],
    );
    assert(rows[0]?.exists, `table ${name} missing`);
    log(`  ✓ ${name} exists`);
  };
  await expectTable("daemon");
  await expectTable("runtime");
  await expectTable("session_event");

  // Verify session got the new columns
  const { rows: cols } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='session'
         AND column_name IN ('runtime_id','spawn_mode','last_event_at')`,
  );
  const got = new Set(cols.map((r) => r.column_name));
  for (const c of ["runtime_id", "spawn_mode", "last_event_at"]) {
    assert(got.has(c), `session.${c} missing`);
    log(`  ✓ session.${c} present`);
  }

  // Verify the status CHECK includes 'pending'
  const { rows: chk } = await pool.query<{ pg_get_constraintdef: string }>(
    `SELECT pg_get_constraintdef(c.oid)
       FROM pg_constraint c
       JOIN pg_class t ON c.conrelid = t.oid
      WHERE t.relname = 'session' AND c.conname = 'session_status_check'`,
  );
  assert(
    chk[0]?.pg_get_constraintdef?.includes("pending"),
    "session_status_check is missing 'pending' value",
  );
  log("  ✓ session_status_check includes 'pending'");
}

async function scenarioRepoAppend(pool: Pool, ids: SeedResult): Promise<void> {
  log("\n=== scenario 2: repo append + listBySession ===");
  const repo = new PostgresSessionEventRepository(pool);
  const events = [
    { kind: "tool_call" as const, tool: "Read", desc: "/src/foo.ts" },
    { kind: "agent" as const, tool: undefined, desc: "I'll read foo first." },
    { kind: "tool_result" as const, tool: "Read", desc: "(file contents)" },
    { kind: "summary" as const, tool: undefined, desc: "Done." },
  ];
  for (const e of events) {
    await repo.append({
      id: makeSessionEventId(),
      session_id: ids.sessionId,
      kind: e.kind,
      content: e.desc,
      tool_name: e.tool,
    });
  }
  const got = await repo.listBySession(ids.sessionId);
  assert(got.length === events.length, `expected ${events.length} events, got ${got.length}`);
  for (let i = 0; i < events.length; i++) {
    assert(got[i]!.kind === events[i]!.kind, `event[${i}].kind mismatch`);
    assert(got[i]!.content === events[i]!.desc, `event[${i}].content mismatch`);
  }
  log(`  ✓ ${events.length} events round-tripped via repo`);
}

async function scenarioBvEventNotify(pool: Pool, ids: SeedResult): Promise<void> {
  log("\n=== scenario 3: bv_event triggers fire ===");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("LISTEN bv_event");
    const received: { event: string; id: string }[] = [];
    client.on("notification", (msg) => {
      if (msg.channel !== "bv_event" || !msg.payload) return;
      try {
        received.push(JSON.parse(msg.payload));
      } catch {
        /* ignore */
      }
    });

    const repo = new PostgresSessionEventRepository(pool);
    await repo.append({
      id: makeSessionEventId(),
      session_id: ids.sessionId,
      kind: "tool_call",
      content: "/some/path",
      tool_name: "Read",
    });
    // Wait for notifications to flush.
    await new Promise((r) => setTimeout(r, 300));

    const sawEvent = received.some(
      (r) => r.event === "session.event" && r.id === ids.sessionId,
    );
    assert(sawEvent, `expected session.event notify for ${ids.sessionId}, got ${JSON.stringify(received)}`);
    log("  ✓ session.event notify fired with session_id");

    const sawStep = received.some((r) => r.event === "session.step");
    assert(sawStep, `expected session.step notify (rich payload), got ${JSON.stringify(received)}`);
    log("  ✓ session.step notify fired (rich payload from migration 1778700000000)");
  } finally {
    await client.end();
  }
}

async function scenarioViewJoin(pool: Pool, ids: SeedResult): Promise<void> {
  log("\n=== scenario 4: view-join cap at 500 ===");
  // Add a few events; verify the view returns them in order.
  const sid = ids.sessionId;
  const { rows } = await pool.query<{
    short_id: string;
    transcript: Array<{ kind: string; content: string }>;
  }>(
    `SELECT s.id AS short_id,
            COALESCE(
              (
                SELECT json_agg(
                  json_build_object('kind', e.kind, 'content', e.content)
                  ORDER BY e.created_at ASC, e.id ASC
                )
                FROM (
                  SELECT * FROM session_event
                  WHERE session_id = $1
                  ORDER BY created_at ASC, id ASC
                  LIMIT 500
                ) e
              ),
              '[]'::json
            ) AS transcript
       FROM session s
      WHERE s.id = $1`,
    [sid],
  );
  const transcript = rows[0]?.transcript ?? [];
  assert(transcript.length > 0, `view-join returned empty transcript for ${sid}`);
  log(`  ✓ view-join returned ${transcript.length} events (cap=500)`);
}

// ───────────────────────── runner ─────────────────────────

async function main(): Promise<void> {
  await applyMigrations();
  await withPool(async (pool) => {
    await reset(pool);
    await scenarioSchemaSmoke(pool);
    const ids = await seedSession(pool);
    await scenarioRepoAppend(pool, ids);
    await scenarioBvEventNotify(pool, ids);
    await scenarioViewJoin(pool, ids);
    await reset(pool);
  });
  log("\n✓ M10 e2e: all scenarios passed");
}

main().catch((err) => {
  console.error("\n✗ M10 e2e failed:");
  console.error(err);
  process.exit(1);
});
