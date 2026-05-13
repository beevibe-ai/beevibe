#!/usr/bin/env tsx
/**
 * Sync core memory block descriptions across all agents from the TS
 * template (DEFAULT_BLOCK_TEMPLATES). Run after editing block
 * descriptions in `packages/core/src/domain/core-memory.ts` to propagate
 * the change to existing agents.
 *
 * The TS template is the single source of truth for block descriptions.
 * `initDefaults` writes the template description on each call (its
 * `ON CONFLICT … description = EXCLUDED.description` clause), so iterating
 * every agent and calling initDefaults is the propagation primitive.
 *
 * Idempotent: safe to re-run. Only the `description` column is rewritten;
 * `content`, `char_limit`, and `is_system` are preserved by the ON CONFLICT
 * branch.
 *
 * Usage:
 *   pnpm sync-core-memory
 */

import { config as loadEnv } from "dotenv";
import { Pool } from "pg";
import { PostgresAgentRepository } from "@beevibe/core/adapters/postgres";
import { PostgresCoreMemoryRepository } from "@beevibe/core/adapters/postgres";

async function main(): Promise<void> {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL not set");
  }

  const pool = new Pool({ connectionString: url });
  const agents = new PostgresAgentRepository(pool);
  const blocks = new PostgresCoreMemoryRepository(pool);

  const { rows } = await pool.query<{ id: string; hierarchy_level: string }>(
    `SELECT id, hierarchy_level FROM agent WHERE archived_at IS NULL`,
  );

  console.log(`[sync] syncing core memory descriptions for ${rows.length} agents…`);

  let synced = 0;
  for (const row of rows) {
    try {
      await blocks.initDefaults(row.id, row.hierarchy_level as "ic" | "team" | "org");
      synced += 1;
    } catch (err) {
      console.error(
        `[sync] failed for agent ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  console.log(`[sync] done — ${synced}/${rows.length} agents updated`);
  await pool.end();
  // agents variable is read for typing — used implicitly via the import
  void agents;
}

main().catch((err: unknown) => {
  console.error("[sync] fatal:", err);
  process.exit(1);
});
