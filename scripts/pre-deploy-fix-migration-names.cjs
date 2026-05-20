/**
 * Idempotent migration-name fix that runs BEFORE node-pg-migrate on
 * Railway. The capability-network rebase shipped two migrations at
 * the same `1780800000000_…` timestamp prefix; the work-product-body
 * file was renamed locally to `1780900000000_…` to break the tie, but
 * production DBs already have the OLD name recorded in `pgmigrations`.
 *
 * node-pg-migrate compares file list vs DB rows by name; sorting puts
 * `1780800000000_add-capability-network` before
 * `1780800000000_add-work-product-body`, and refuses to run the
 * "preceding" one with code 1.
 *
 * Fix: rename the recorded row to match the new filename so the file
 * and DB agree. Safe in all states:
 *   - Old name recorded → UPDATE flips it to the new name (this deploy).
 *   - Already renamed   → 0 rows updated (subsequent deploys).
 *   - Fresh DB          → no matching row, 0 updates.
 *
 * Plain CommonJS so we don't need tsx/ts-node in the api image — `pg`
 * is already a runtime dep of @beevibe/core which the api bundles.
 */
const { Client } = require("pg");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[pre-deploy] DATABASE_URL not set; skipping fix.");
    process.exit(0);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    // Guard against the table not existing on first-ever deploys —
    // node-pg-migrate creates it on its own first run.
    const exists = await client.query(
      `SELECT to_regclass('public.pgmigrations') IS NOT NULL AS present`,
    );
    if (!exists.rows[0]?.present) {
      console.log("[pre-deploy] pgmigrations table not present; nothing to rename.");
      return;
    }
    const result = await client.query(
      `UPDATE pgmigrations
         SET name = '1780900000000_add-work-product-body'
       WHERE name = '1780800000000_add-work-product-body'`,
    );
    console.log(
      `[pre-deploy] migration-name fix: renamed ${result.rowCount} row(s).`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[pre-deploy] migration-name fix failed:", err);
  process.exit(1);
});
