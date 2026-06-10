/**
 * Seed believable past conversations so session_search has something to
 * recall when you chat with the demo agent.
 *
 * Targets the dev DB (DATABASE_URL). Plants:
 *
 *   1. A FAILED task session on Backend Platform team:
 *      "Refactor the authentication middleware to use the new JWT library"
 *      → trigger by asking "what happened with the auth refactor?"
 *
 *   2. A SUCCEEDED task session on a new IC subordinate of Backend
 *      Platform team ("backend-eng" agent — created if missing):
 *      "Migrate the billing calculator to handle tiered pricing"
 *      → trigger by asking "show me the billing migration"
 *      → trigger team scope by asking from the team agent ("did anyone
 *        on my team do work on billing?")
 *
 *   3. A multi-turn chat conversation about Docker setup
 *      → trigger by asking "what did we discuss about docker?"
 *
 * Idempotent: rerunnable. Uses `seed_demo_` id prefix so cleanup is easy.
 *
 *   pnpm tsx scripts/seed-session-search-demo.ts          # seed
 *   pnpm tsx scripts/seed-session-search-demo.ts --clean  # delete + exit
 *   pnpm tsx scripts/seed-session-search-demo.ts --reset  # delete + seed
 */

import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import {
  PostgresAgentRepository,
  PostgresSessionEventRepository,
  PostgresSessionRepository,
  PostgresTaskRepository,
  createPool,
} from "../packages/core/src/adapters/postgres/index.js";
import { DEFAULT_RUNTIME_CONFIG } from "../packages/core/src/domain/agent.js";
import {
  agentId as makeAgentId,
  sessionEventId as makeEventId,
  sessionId as makeSessionId,
  taskId as makeTaskId,
} from "../packages/core/src/domain/ids.js";

// ── Fixed targets (provisioned by `pnpm tsx scripts/provision-demo.ts`) ─
// "captain" is the team-tier agent the demo bv_u_ token resolves to.
// Owner is the demo person. Update both if you re-provision the demo
// (provision-demo prints new ids on every run).
const OWNER_ID = "person_bsxQ0jTvBhtR";
const TEAM_AGENT_ID = "agent_CaHbPWBoB9FQ"; // "captain" (team)
/**
 * IC subordinate of captain — ic-alice. Already created by
 * provision-demo, so we don't recreate it (we still need its id for the
 * billing-migration session). ic-bob exists too but we only need one IC
 * for the team-scope discovery demo.
 */
const IC_AGENT_ID_FALLBACK = "agent_glrqdzhOhlWD"; // ic-alice

// ── Synthetic ids carry SEED_TAG so cleanup is straightforward ──────
const SEED_TAG = "seed_demo";
const ID = {
  ic:   `agent_${SEED_TAG}_backend_eng`,
  // Tasks
  authTask:    `task_${SEED_TAG}_auth_refactor`,
  billingTask: `task_${SEED_TAG}_billing_migration`,
  // Sessions
  authSess:     `sess_${SEED_TAG}_auth_attempt`,
  billingSess:  `sess_${SEED_TAG}_billing_attempt`,
  dockerTurn1:  `sess_${SEED_TAG}_docker_t1`,
  dockerTurn2:  `sess_${SEED_TAG}_docker_t2`,
  dockerTurn3:  `sess_${SEED_TAG}_docker_t3`,
};

function log(s: string) {
  console.log(`  ${s}`);
}
function header(s: string) {
  console.log(`\n\x1b[1m\x1b[36m${s}\x1b[0m`);
}

async function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

async function cleanup(pool: ReturnType<typeof createPool>) {
  header("Cleaning up previous seed");
  await pool.query(
    `DELETE FROM session_event WHERE session_id IN (SELECT id FROM session WHERE id LIKE $1)`,
    [`%${SEED_TAG}%`],
  );
  await pool.query(`DELETE FROM session WHERE id LIKE $1`, [`%${SEED_TAG}%`]);
  await pool.query(`DELETE FROM task WHERE id LIKE $1`, [`%${SEED_TAG}%`]);
  await pool.query(`DELETE FROM agent WHERE id LIKE $1`, [`%${SEED_TAG}%`]);
  log("✓ removed prior seed_demo_ rows");
}

async function ensureIcAgent(agents: PostgresAgentRepository): Promise<string> {
  // Prefer an IC provisioned by provision-demo (ic-alice / ic-bob).
  // Falls back to creating a dedicated seed-demo IC if that's missing
  // (e.g. demo was --clean'd between runs).
  const fallback = await agents.findById(IC_AGENT_ID_FALLBACK);
  if (fallback && fallback.parent_agent_id === TEAM_AGENT_ID) {
    log(`✓ using existing IC subordinate "${fallback.name}" (${fallback.id})`);
    return fallback.id;
  }
  const existing = await agents.findById(ID.ic);
  if (existing) {
    log(`✓ seed-demo IC subordinate already exists: ${ID.ic}`);
    return ID.ic;
  }
  const a = await agents.create({
    id: ID.ic,
    name: "backend-eng",
    owner_id: OWNER_ID,
    hierarchy_level: "ic",
    parent_agent_id: TEAM_AGENT_ID,
    runtime_config: DEFAULT_RUNTIME_CONFIG,
  });
  log(`✓ created IC subordinate "${a.name}" (${a.id})`);
  return a.id;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = createPool({ connectionString: url, max: 4 });

  const wantClean = process.argv.includes("--clean");
  const wantReset = process.argv.includes("--reset");

  if (wantClean || wantReset) {
    await cleanup(pool);
    if (wantClean) {
      await pool.end();
      return;
    }
  }

  const agents = new PostgresAgentRepository(pool);
  const tasks = new PostgresTaskRepository(pool);
  const sessions = new PostgresSessionRepository(pool);
  const events = new PostgresSessionEventRepository(pool);

  header("Verifying target");
  const team = await agents.findById(TEAM_AGENT_ID);
  if (!team) {
    throw new Error(
      `Team agent ${TEAM_AGENT_ID} not found — run \`pnpm provision-demo\` first or update OWNER_ID/TEAM_AGENT_ID at the top of this file.`,
    );
  }
  log(`✓ team agent "${team.name}" (${team.id})`);

  header("Ensuring IC subordinate");
  const icId = await ensureIcAgent(agents);

  // ── 1) FAILED auth refactor task (on the team agent itself) ───────
  header("Seeding past task: failed auth middleware refactor");
  if (!(await tasks.findById(ID.authTask))) {
    await tasks.create({
      id: ID.authTask,
      title: "Refactor authentication middleware",
      priority: "high",
      creator_id: OWNER_ID,
      creator_type: "person",
    });
  }
  if (!(await sessions.findById(ID.authSess))) {
    await sessions.create({
      id: ID.authSess,
      agent_id: TEAM_AGENT_ID,
      task_id: ID.authTask,
      type: "task",
      status: "failed",
      intent:
        "Refactor the authentication middleware to use the new JWT library — the old session-token flow needs to go.",
    });
    const authTurns = [
      "Starting by mapping every call site of the old session-token middleware. Grepping setAuthCookie and parseAuthToken across packages/api and packages/web.",
      "Found 23 call sites across packages/api and packages/web. About to start migrating one route at a time, starting with the lowest-traffic endpoints.",
      "Hit a snag: the new JWT library's verify() throws on expired tokens, but the existing middleware silently returns null. Need a thin wrapper to preserve the existing contract while we migrate callers.",
      "Test suite is failing in unexpected places — looks like several integration tests assume the old auth header shape. Blocking on user direction: do we migrate the tests too, or keep both formats supported during the transition?",
    ];
    for (const turn of authTurns) {
      await events.append({
        id: makeEventId(),
        session_id: ID.authSess,
        kind: "agent",
        content: turn,
        tool_name: undefined,
      });
      await sleep(5);
    }
    log(`✓ auth refactor session (FAILED) with 4 agent turns`);
  } else {
    log(`✓ auth refactor session already present`);
  }

  // ── 2) SUCCEEDED billing migration on the IC subordinate ──────────
  header("Seeding past task: succeeded billing migration (subordinate)");
  if (!(await tasks.findById(ID.billingTask))) {
    await tasks.create({
      id: ID.billingTask,
      title: "Migrate billing calculator to tiered pricing",
      priority: "medium",
      creator_id: OWNER_ID,
      creator_type: "person",
    });
  }
  if (!(await sessions.findById(ID.billingSess))) {
    await sessions.create({
      id: ID.billingSess,
      agent_id: icId,
      task_id: ID.billingTask,
      type: "task",
      status: "succeeded",
      intent:
        "Migrate the billing calculator to handle tiered pricing — current flat-rate code needs to support per-tier rates and a usage threshold.",
    });
    const billTurns = [
      "Pulled the calculator out of packages/api/src/billing/index.ts into its own module so it can be unit-tested in isolation.",
      "Added 14 new unit tests covering the tier boundary cases — 0 usage, mid-tier, exactly-at-threshold, and overflow into next tier.",
      "Refactor is done. Old call sites all migrated. Tests passing. Shipped behind a feature flag billing.tiered_pricing for safe rollout.",
    ];
    for (const turn of billTurns) {
      await events.append({
        id: makeEventId(),
        session_id: ID.billingSess,
        kind: "agent",
        content: turn,
        tool_name: undefined,
      });
      await sleep(5);
    }
    log(`✓ billing migration session (SUCCEEDED) with 3 agent turns`);
  } else {
    log(`✓ billing migration session already present`);
  }

  // ── 3) Multi-turn chat about Docker setup (on the team agent) ─────
  header("Seeding past chat conversation: Docker setup");
  if (!(await sessions.findById(ID.dockerTurn1))) {
    await sessions.create({
      id: ID.dockerTurn1,
      agent_id: TEAM_AGENT_ID,
      type: "chat",
      intent: "Can you walk me through getting docker compose running locally for the beevibe stack?",
    });
    await events.append({
      id: makeEventId(),
      session_id: ID.dockerTurn1,
      kind: "agent",
      content:
        "Sure — first make sure Docker Desktop is running. Then `docker compose up -d postgres` from the repo root. After that, `pnpm dev` starts the rest of the stack.",
      tool_name: undefined,
    });
    await sleep(5);
    await sessions.create({
      id: ID.dockerTurn2,
      agent_id: TEAM_AGENT_ID,
      type: "chat",
      intent: "My docker compose says ECONNREFUSED on port 5433. Why is that?",
      prior_session_id: ID.dockerTurn1,
    });
    await events.append({
      id: makeEventId(),
      session_id: ID.dockerTurn2,
      kind: "agent",
      content:
        "Port 5433 is the test database (DATABASE_URL_TEST in your .env). The container is probably still starting — wait a few seconds and try again, or run `docker exec beevibe-postgres pg_isready -U beevibe` until it answers.",
      tool_name: undefined,
    });
    await sleep(5);
    await sessions.create({
      id: ID.dockerTurn3,
      agent_id: TEAM_AGENT_ID,
      type: "chat",
      intent: "Got it, that worked. Any tips for keeping the stack healthy?",
      prior_session_id: ID.dockerTurn2,
    });
    await events.append({
      id: makeEventId(),
      session_id: ID.dockerTurn3,
      kind: "agent",
      content:
        "Three things: 1) always Ctrl+C `pnpm dev` cleanly so tsx watchers shut down, 2) if ports stay held after a crash run `pkill -f 'beevibe/(packages|scripts)'`, 3) restart the docker container with `docker compose restart postgres` if you see WAL replay errors.",
      tool_name: undefined,
    });
    log(`✓ docker chat conversation (3 turns)`);
  } else {
    log(`✓ docker chat conversation already present`);
  }

  // ── Summary + prompts to try ──────────────────────────────────────
  header("Seeded. Suggested prompts to test session_search in chat:");
  console.log(`
  Failed task recall (status filter):
    "What happened with the auth middleware refactor? I don't remember
     how it ended."

  Team-scope cross-agent recall:
    "Did anyone on my team do work on billing recently? I want to see
     what they shipped."

  Chat conversation recall:
    "What did we discuss about Docker setup last time?"

  Browse (no specific topic):
    "What was I working on recently?"

  Filtered recall:
    "Find any past session that failed."
`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
