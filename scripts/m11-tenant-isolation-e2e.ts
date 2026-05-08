/**
 * M11 e2e — proves OwnerLookup blocks cross-user SSE leakage.
 *
 * The gating test: token A subscribed to /api/stream MUST NOT receive
 * events scoped to token B's agents. This is the load-bearing property
 * that lets multi-tenant signup (Phase 6, #63) ship safely.
 *
 * Verifies in a single live process:
 *   1. Two distinct persons + agents seeded.
 *   2. Two SSE subscribers (one per person) registered against the same
 *      SseManager.
 *   3. publish() with each person's owner set delivers only to their
 *      subscriber.
 *   4. End-to-end through the listener: a real pg_notify → SseListener →
 *      OwnerLookup → SseManager → only the right subscriber fires.
 *
 * Doesn't spawn claude — Phase 2 doesn't change runtime spawning, only
 * SSE filtering.
 *
 * Usage:
 *   RUN_M11_E2E=1 \
 *   DATABASE_URL_TEST=postgresql://beevibe:beevibe@localhost:5433/beevibe_test \
 *     pnpm tsx scripts/m11-tenant-isolation-e2e.ts
 */

import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
loadEnv({ path: resolve(repoRoot, ".env") });

import {
  agentId as makeAgentId,
  personId as makePersonId,
  taskId as makeTaskId,
} from "../packages/core/src/domain/ids.js";
import { DEFAULT_RUNTIME_CONFIG } from "../packages/core/src/domain/agent.js";
import { provisionAgent } from "../packages/core/src/auth/provision.js";
import { PostgresAgentRepository } from "../packages/core/src/adapters/postgres/agent-repo.js";
import { PostgresCoreMemoryRepository } from "../packages/core/src/adapters/postgres/core-memory-repo.js";
import { PostgresPersonRepository } from "../packages/core/src/adapters/postgres/person-repo.js";
import { createPool, type Pool } from "../packages/core/src/adapters/postgres/client.js";
import { SseManager, type BvEvent } from "../packages/api/src/sse/manager.js";
import { SseListener } from "../packages/api/src/sse/listener.js";
import { OwnerLookup } from "../packages/api/src/sse/owner-lookup.js";

const REQUIRED = ["RUN_M11_E2E", "DATABASE_URL_TEST"] as const;
for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`✗ M11 E2E: missing env var ${k}`);
    process.exit(1);
  }
}
const databaseUrl = process.env.DATABASE_URL_TEST!;

const log = (msg: string) => console.log(msg);
const assert = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function applyMigrations(): Promise<void> {
  log("→ applying migrations against DATABASE_URL_TEST");
  execSync("pnpm migrate:test up", {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
}

async function reset(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      session_event, session, task, work_product, memory_fact,
      core_memory_block, agent, person
    CASCADE
  `);
}

interface SeededTenant {
  personId: string;
  agentId: string;
}

async function seed(pool: Pool, label: string): Promise<SeededTenant> {
  const persons = new PostgresPersonRepository(pool);
  const agents = new PostgresAgentRepository(pool);
  const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
  const owner = await persons.create({
    id: makePersonId(),
    name: `m11-${label}`,
    email: `m11-${label}-${Date.now()}@example.test`,
  });
  const { agent } = await provisionAgent(
    { agentRepo: agents, coreMemoryRepo },
    {
      id: makeAgentId(),
      name: `M11 ${label} agent`,
      owner_id: owner.id,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    },
  );
  return { personId: owner.id, agentId: agent.id };
}

async function insertTask(pool: Pool, agentId: string): Promise<string> {
  const tid = makeTaskId();
  await pool.query(
    `INSERT INTO task (id, title, description, assignee_id, creator_id, creator_type, status)
     VALUES ($1, $2, $3, $4, $5, 'agent', 'pending')`,
    [tid, "m11 isolation", "isolation probe", agentId, agentId],
  );
  return tid;
}

// ───────────────────────── scenario 1 ─────────────────────────
//
// Direct SseManager.publish() with a known owner set: subscriber A
// fires when owner set contains person A; subscriber B does NOT fire.
async function scenarioPublishFiltering(pool: Pool): Promise<void> {
  log("\n=== scenario 1: SseManager.publish() filters by personId ===");
  const a = await seed(pool, "A");
  const b = await seed(pool, "B");

  const manager = new SseManager();
  const aReceived: BvEvent[] = [];
  const bReceived: BvEvent[] = [];
  const unA = manager.subscribe(a.personId, (e) => aReceived.push(e));
  const unB = manager.subscribe(b.personId, (e) => bReceived.push(e));

  const event: BvEvent = { event: "task.updated", id: "task_x" };
  manager.publish(event, new Set([a.personId]));
  assert(aReceived.length === 1, `A should receive 1, got ${aReceived.length}`);
  assert(bReceived.length === 0, `B should receive 0, got ${bReceived.length}`);
  log("  ✓ event with owner=A delivered only to A");

  manager.publish(event, new Set([b.personId]));
  assert(aReceived.length === 1, "A should still be 1");
  assert(bReceived.length === 1, "B should now be 1");
  log("  ✓ event with owner=B delivered only to B");

  manager.publish(event, new Set());
  assert(aReceived.length === 1 && bReceived.length === 1, "empty owner set should drop");
  log("  ✓ empty owner set drops (fail-closed)");

  unA();
  unB();
}

// ───────────────────────── scenario 2 ─────────────────────────
//
// Real listener path: OwnerLookup resolves owner from DB, SseListener
// publishes to manager. Inserting a task for person A's agent fires
// `task.created` notification; only A's subscriber should see it.
async function scenarioListenerPath(pool: Pool): Promise<void> {
  log("\n=== scenario 2: end-to-end via SseListener + OwnerLookup ===");
  await reset(pool);
  const a = await seed(pool, "A2");
  const b = await seed(pool, "B2");

  const manager = new SseManager();
  const ownerLookup = new OwnerLookup(pool);
  const listener = new SseListener({
    databaseUrl,
    manager,
    ownerLookup,
    reconnectDelayMs: 1_000,
  });
  listener.start();

  const aReceived: BvEvent[] = [];
  const bReceived: BvEvent[] = [];
  manager.subscribe(a.personId, (e) => aReceived.push(e));
  manager.subscribe(b.personId, (e) => bReceived.push(e));

  // Tiny delay so the listener finishes its LISTEN before we INSERT.
  await sleep(500);

  const tidA = await insertTask(pool, a.agentId);
  await sleep(800); // allow notify → ownerLookup query → publish chain

  const aSawA = aReceived.some((e) => e.event === "task.created" && e.id === tidA);
  const bSawA = bReceived.some((e) => e.event === "task.created" && e.id === tidA);
  assert(aSawA, "A should see task.created for its own task");
  assert(!bSawA, "B should NOT see task.created for A's task");
  log(`  ✓ task.created for A's task (id=${tidA}) reached A only`);

  const tidB = await insertTask(pool, b.agentId);
  await sleep(800);

  const aSawB = aReceived.some((e) => e.event === "task.created" && e.id === tidB);
  const bSawB = bReceived.some((e) => e.event === "task.created" && e.id === tidB);
  assert(bSawB, "B should see task.created for its own task");
  assert(!aSawB, "A should NOT see task.created for B's task");
  log(`  ✓ task.created for B's task (id=${tidB}) reached B only`);

  await listener.stop();
}

// ───────────────────────── runner ─────────────────────────

async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = createPool({ connectionString: databaseUrl });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  await applyMigrations();
  await withPool(async (pool) => {
    await reset(pool);
    await scenarioPublishFiltering(pool);
    await scenarioListenerPath(pool);
    await reset(pool);
  });
  log("\n✓ M11 e2e: all scenarios passed");
}

main().catch((err) => {
  console.error("\n✗ M11 e2e failed:");
  console.error(err);
  process.exit(1);
});
