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
