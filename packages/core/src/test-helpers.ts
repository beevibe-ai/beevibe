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

const ALL_TABLES = [
  "escalation",
  "negotiation_round",
  "negotiation",
  "memory_fact",
  "work_product",
  "core_memory_block",
  "session",
  "task",
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
