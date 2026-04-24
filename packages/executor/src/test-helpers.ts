import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@beevibe/core/adapters/postgres";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const ALL_TABLES = [
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
  await pool.query(`TRUNCATE ${ALL_TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}
