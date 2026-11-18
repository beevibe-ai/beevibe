import { afterAll, beforeAll, beforeEach } from "vitest";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import type { Pool } from "./adapters/postgres/client.js";
import { createPool } from "./adapters/postgres/client.js";

// Resolve the repo-root .env file so tests work regardless of cwd
// (vitest runs from the package dir; .env is at the repo root).
// Both source (packages/core/src/test-helpers.ts) and built dist
// (packages/core/dist/test-helpers.js) are 3 levels up from repo root.
const here = dirname(fileURLToPath(import.meta.url));
const repoRootEnv = resolve(here, "../../../.env");
loadEnv({ path: repoRootEnv });

// Children before parents — saves CASCADE work on every TRUNCATE.
const ALL_TABLES = [
  "task_watch",
  "escalation",
  "negotiation_round",
  "negotiation",
  "memory_promotion_event",
  "memory_fact",
  "work_product",
  "session_event",
  "core_memory_block",
  "session",
  "task",
  "runtime",
  "daemon",
  "agent",
  "person",
];

export function createTestPool(): Pool {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error(
      "DATABASE_URL_TEST env var is required for integration tests. " +
        "Set it in .env or export it before running vitest.",
    );
  }
  return createPool({ connectionString: url, max: 4 });
}

export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(
    `TRUNCATE ${ALL_TABLES.join(", ")} RESTART IDENTITY CASCADE`,
  );
}

/**
 * Open a Postgres pool for the enclosing suite and register its whole
 * lifecycle: truncate between cases, close when the suite is done.
 *
 * Every one of the ~29 integration suites in this monorepo hand-rolled
 * the same three hooks:
 *
 * ```ts
 * let pool: Pool;
 * beforeAll(() => { pool = createTestPool(); ... });
 * beforeEach(async () => { await truncateAll(pool); });
 * afterAll(async () => { await pool.end(); });
 * ```
 *
 * The copies were not harmless. `pool` was declared as `Pool` but only
 * assigned inside `beforeAll`, so when `createTestPool()` threw — which
 * is exactly what happens with no `DATABASE_URL_TEST`, the single most
 * common way to run these — `afterAll` then dereferenced `undefined` and
 * threw `Cannot read properties of undefined (reading 'end')` on top of
 * the real error. That second throw is unhandled, and an unhandled error
 * in a test file aborts vitest's coverage report generation entirely, so
 * the missing-env message arrived buried under a cascade and a coverage
 * sweep silently produced no `coverage-summary.json`. 27 of the 29 files
 * had the unguarded teardown; `routes/mcp.test.ts` had already grown a
 * local `pool?.end()` workaround.
 *
 * Opening the pool eagerly removes that failure mode by construction:
 * there is no window in which `pool` is undefined. `createPool` only
 * builds the pool object — pg connects lazily, on first query — so this
 * costs nothing at suite-collection time, and a missing
 * `DATABASE_URL_TEST` now surfaces once, as itself.
 *
 * One suite deliberately keeps its own copy: `api/routes/mcp.test.ts` is
 * wrapped in `describe.skipIf(!HAS_LIVE_API_KEYS)`, and vitest evaluates
 * even a skipped suite's body to enumerate its tests. Calling this there
 * would demand `DATABASE_URL_TEST` in order to collect a suite that is
 * about to be skipped anyway, so it would start failing everywhere
 * without provider keys. Keeping the pool in its `beforeAll` is why that
 * file already carried the `pool?.end()` workaround.
 *
 * Call it as the first statement in the `describe` body. Hook order is
 * load-bearing and works out in both directions:
 *
 *   - vitest runs `beforeEach` in registration order, so the truncate
 *     registered here lands before a suite's own row-seeding `beforeEach`
 *   - vitest runs `afterAll` in reverse registration order, so the pool
 *     closes *after* a suite's own teardown (`ws-server.test.ts` stops its
 *     websocket server there) — teardown that still needs to query
 *
 * ```ts
 * describe("agent repo", () => {
 *   const pool = setupTestPool();
 *   let agents: PostgresAgentRepository;
 *   beforeAll(() => { agents = new PostgresAgentRepository(pool); });
 *   // …
 * });
 * ```
 */
export interface SetupTestPoolOptions {
  /**
   * When to wipe the tables.
   *
   * `"each"` (the default) truncates before every test — the right thing
   * for a suite that seeds its rows in `beforeEach`, which is nearly all
   * of them, and what keeps cases independent.
   *
   * `"once"` truncates a single time before the suite's own `beforeAll`.
   * A suite that seeds an expensive fixture *in* `beforeAll` and then
   * reads it from several tests needs this — a per-test truncate would
   * delete the fixture out from under test 2 onward. `views/mesh.db` is
   * the only suite in the repo that needs it.
   */
  truncate?: "each" | "once";
}

export function setupTestPool(opts: SetupTestPoolOptions = {}): Pool {
  const pool = createTestPool();
  // Registered here, ahead of the suite's own hooks: vitest runs
  // `beforeAll`/`beforeEach` in registration order, so the wipe always
  // precedes whatever the suite seeds.
  if (opts.truncate === "once") {
    beforeAll(async () => {
      await truncateAll(pool);
    });
  } else {
    beforeEach(async () => {
      await truncateAll(pool);
    });
  }
  // `afterAll` runs in *reverse* registration order, so this close lands
  // after the suite's own teardown rather than before it.
  afterAll(async () => {
    await pool.end();
  });
  return pool;
}

/**
 * Insert a daemon + runtime row pair so an integration test can pin a
 * session to a non-null `runtime_id`. Used by tests that need to assert
 * runtime-aware behavior (claim routing, watch-tasks wake inheritance,
 * etc.) without dragging in the daemon HTTP onboarding flow. Returns
 * the new ids; deleting the rows is unnecessary if the test relies on
 * `truncateAll` between cases.
 */
export async function seedPinnedRuntime(
  pool: Pool,
  opts: { personId: string; suffix?: string },
): Promise<{ daemonId: string; runtimeId: string }> {
  const suffix = opts.suffix ?? Date.now().toString();
  const daemonId = `dmn_pin_${suffix}`;
  const runtimeId = `rt_pin_${suffix}`;
  await pool.query(
    `INSERT INTO daemon (id, owner_person_id, external_id, device_name, token_hash)
     VALUES ($1, $2, $3, $4, $5)`,
    [daemonId, opts.personId, `ext_${suffix}`, `dev_${suffix}`, `hash_${suffix}`],
  );
  await pool.query(
    `INSERT INTO runtime (id, daemon_id, cli, capabilities)
     VALUES ($1, $2, 'claude', '{}'::jsonb)`,
    [runtimeId, daemonId],
  );
  return { daemonId, runtimeId };
}
