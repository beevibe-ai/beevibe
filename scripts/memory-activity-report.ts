/**
 * memory-activity-report.ts — Layer A telemetry for memory write behavior.
 *
 * Activity-level eval signal for memory tooling. Answers questions like:
 *   - How many archival writes per week, and which fact_types dominate?
 *   - Which agents are dormant vs heavy writers?
 *   - How many core blocks have ever been edited after creation?
 *   - Did fact-type distribution shift after a given date? (before/after for
 *     prompt-change rollouts — e.g. PR #247 merged 2026-06-14.)
 *
 * Not a quality metric — an activity metric. Use this as the cheap first
 * signal; Layers B (LLM-as-judge over real sessions) and C (synthetic
 * fixtures) cover quality.
 *
 * Usage:
 *   pnpm tsx scripts/memory-activity-report.ts                       # 12-week default
 *   pnpm tsx scripts/memory-activity-report.ts --weeks 4             # last N weeks
 *   pnpm tsx scripts/memory-activity-report.ts --since 2026-06-14    # ±14d split around date
 *
 * Limitations (worth knowing before you read the numbers):
 *   - memory_fact has full INSERT history, so archival writes are exact.
 *   - core_memory_block has only `updated_at` (current state, no event log).
 *     Time-series rate of core writes is NOT recoverable from current
 *     schema. We surface the snapshot proxies (`ever_updated`,
 *     `updated_in_30d`) but they undercount churn — a block updated 5
 *     times in 30d shows as 1. A follow-up migration adding a
 *     `core_memory_write_event` trigger would close that gap going forward.
 */

import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import { createPool } from "../packages/core/src/adapters/postgres/index.js";

// ─────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function arg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return undefined;
  const next = args[idx + 1];
  // Guard against the user omitting the value: `--since --weeks 4` would
  // otherwise capture "--weeks" as the date.
  return next && !next.startsWith("--") ? next : undefined;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

const WEEKS = (() => {
  const raw = arg("weeks") ?? "12";
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    die(`--weeks must be a positive integer (got: ${raw}).`);
  }
  return n;
})();

const SINCE = (() => {
  const raw = arg("since");
  if (!raw) return undefined;
  // Validate up front so we fail with a clear CLI-level message rather
  // than seven reports in with an opaque Postgres timestamp parse error.
  if (Number.isNaN(Date.parse(raw))) {
    die(`--since must be an ISO date (got: ${raw}). Example: 2026-06-14`);
  }
  return raw;
})();

if (!process.env.DATABASE_URL) {
  die("Set DATABASE_URL (see .env or export it).");
}

const pool = createPool({ connectionString: process.env.DATABASE_URL });

// ─────────────────────────────────────────────────────────────────────────
// Tiny print helpers (no table library — keep it scriptable)
// ─────────────────────────────────────────────────────────────────────────

function rule(title: string): void {
  console.log(`\n${"━".repeat(76)}`);
  console.log(`  ${title}`);
  console.log(`${"━".repeat(76)}`);
}

function printRows(rows: Record<string, unknown>[]): void {
  if (!rows.length) {
    console.log("  (no rows)");
    return;
  }
  const keys = Object.keys(rows[0]!);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => render(r[k]).length)),
  );
  console.log("  " + keys.map((k, i) => k.padEnd(widths[i]!)).join("  "));
  console.log("  " + keys.map((_, i) => "─".repeat(widths[i]!)).join("  "));
  for (const r of rows) {
    console.log(
      "  " + keys.map((k, i) => render(r[k]).padEnd(widths[i]!)).join("  "),
    );
  }
}

function render(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (v instanceof Date) {
    // node-postgres parses `::date` columns as JS Date at LOCAL midnight,
    // so `.toISOString()` (which is UTC) shifts the day back by the
    // local UTC offset for anyone east of UTC. Read the local components
    // directly to keep the displayed date == the row's stored date.
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v);
}

// ─────────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────────

async function archivalActivityByWeek(): Promise<void> {
  rule(`ARCHIVAL WRITES BY WEEK — last ${WEEKS} weeks`);
  const { rows } = await pool.query(
    `SELECT date_trunc('week', created_at AT TIME ZONE 'UTC')::date AS week,
            COUNT(*)                                                AS total,
            COUNT(*) FILTER (WHERE fact_type = 'belief')            AS belief,
            COUNT(*) FILTER (WHERE fact_type = 'pattern')           AS pattern,
            COUNT(*) FILTER (WHERE fact_type = 'gotcha')            AS gotcha,
            COUNT(*) FILTER (WHERE fact_type = 'preference')        AS preference,
            COUNT(*) FILTER (WHERE fact_type = 'decision')          AS decision,
            COUNT(DISTINCT agent_id)                                AS active_agents
       FROM memory_fact
      WHERE created_at >= NOW() - $1::interval
   GROUP BY week
   ORDER BY week DESC`,
    [`${WEEKS} weeks`],
  );
  printRows(rows);
}

async function archivalByScopeAndType(): Promise<void> {
  rule(`ARCHIVAL BY SCOPE × FACT_TYPE — last ${WEEKS} weeks`);
  const { rows } = await pool.query(
    `SELECT scope, fact_type, COUNT(*) AS writes
       FROM memory_fact
      WHERE created_at >= NOW() - $1::interval
   GROUP BY scope, fact_type
   ORDER BY scope, writes DESC`,
    [`${WEEKS} weeks`],
  );
  printRows(rows);
}

async function topActiveAgents(): Promise<void> {
  rule("TOP AGENTS BY ARCHIVAL ACTIVITY — last 30 days (max 20)");
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.hierarchy_level                  AS tier,
            COUNT(mf.id)                                     AS writes_30d,
            COUNT(DISTINCT mf.fact_type)                     AS type_variety,
            MAX(mf.created_at)::date                         AS last_write
       FROM agent a
       LEFT JOIN memory_fact mf
              ON mf.agent_id = a.id
             AND mf.created_at >= NOW() - INTERVAL '30 days'
   GROUP BY a.id, a.name, a.hierarchy_level
     HAVING COUNT(mf.id) > 0
   ORDER BY writes_30d DESC
      LIMIT 20`,
  );
  printRows(rows);
}

async function dormantAgents(): Promise<void> {
  rule("AGENTS WITH NO ARCHIVAL WRITES IN 30 DAYS (max 20, newest first)");
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.hierarchy_level                  AS tier,
            (SELECT MAX(created_at)::date FROM memory_fact
              WHERE agent_id = a.id)                         AS last_write_ever,
            a.created_at::date                               AS agent_created
       FROM agent a
      WHERE NOT EXISTS (
              SELECT 1 FROM memory_fact mf
               WHERE mf.agent_id = a.id
                 AND mf.created_at > NOW() - INTERVAL '30 days')
   ORDER BY a.created_at DESC
      LIMIT 20`,
  );
  printRows(rows);
}

async function coreSnapshot(): Promise<void> {
  rule("CORE MEMORY — current-state snapshot (no write history available)");
  const { rows } = await pool.query(
    `SELECT a.hierarchy_level                                         AS tier,
            cmb.block_name,
            COUNT(*)                                                  AS blocks,
            COUNT(*) FILTER (WHERE LENGTH(cmb.content) > 0)           AS non_empty,
            COUNT(*) FILTER (WHERE cmb.updated_at > cmb.created_at)   AS ever_updated,
            COUNT(*) FILTER (WHERE cmb.updated_at > NOW() - INTERVAL '30 days'
                                AND cmb.updated_at > cmb.created_at)  AS updated_30d,
            ROUND(AVG(LENGTH(cmb.content)))                           AS avg_chars
       FROM core_memory_block cmb
       JOIN agent a ON a.id = cmb.agent_id
   GROUP BY a.hierarchy_level, cmb.block_name
   ORDER BY a.hierarchy_level, cmb.block_name`,
  );
  printRows(rows);
}

async function archivalToCoreRatio(): Promise<void> {
  rule("ARCHIVAL-TO-CORE-TOUCH RATIO — last 30 days, per agent (max 25)");
  console.log(
    "  High ratio = lots of archival writes, never touches core (the bias problem).",
  );
  console.log(
    "  Low ratio with non-zero core_touched_30d = balanced manager.\n",
  );
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.hierarchy_level                  AS tier,
            arch.cnt                                         AS archival_30d,
            core.cnt                                         AS core_touched_30d,
            CASE WHEN core.cnt > 0
                 THEN ROUND(arch.cnt::numeric / core.cnt, 1) END
                                                             AS ratio
       FROM agent a
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt FROM memory_fact
          WHERE agent_id = a.id AND created_at > NOW() - INTERVAL '30 days'
       ) arch ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt FROM core_memory_block
          WHERE agent_id = a.id
            AND updated_at > NOW() - INTERVAL '30 days'
            AND updated_at > created_at
       ) core ON TRUE
      WHERE arch.cnt > 0 OR core.cnt > 0
   ORDER BY arch.cnt DESC NULLS LAST
      LIMIT 25`,
  );
  printRows(rows);
}

async function beforeAfter(): Promise<void> {
  if (!SINCE) return;

  rule(`BEFORE / AFTER SPLIT — boundary = ${SINCE}, ±14 days each side`);
  console.log(
    "  Use to evaluate a prompt-change rollout (e.g. PR #247 merged 2026-06-14).\n",
  );

  const { rows: byType } = await pool.query(
    `WITH win AS (
       SELECT * FROM memory_fact
        WHERE created_at >= $1::timestamptz - INTERVAL '14 days'
          AND created_at  < $1::timestamptz + INTERVAL '14 days'
     ),
     totals AS (
       SELECT
         COUNT(*) FILTER (WHERE created_at <  $1::timestamptz) AS pre_total,
         COUNT(*) FILTER (WHERE created_at >= $1::timestamptz) AS post_total
         FROM win
     )
     SELECT
       fact_type,
       COUNT(*) FILTER (WHERE created_at <  $1::timestamptz)  AS pre,
       COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)  AS post,
       ROUND(100.0 * COUNT(*) FILTER (WHERE created_at <  $1::timestamptz)
             / NULLIF((SELECT pre_total  FROM totals), 0), 1) AS pre_pct,
       ROUND(100.0 * COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)
             / NULLIF((SELECT post_total FROM totals), 0), 1) AS post_pct
       FROM win
   GROUP BY fact_type
   ORDER BY fact_type`,
    [SINCE],
  );
  console.log("  ── fact_type mix");
  printRows(byType);

  const { rows: agg } = await pool.query(
    `WITH win AS (
       SELECT * FROM memory_fact
        WHERE created_at >= $1::timestamptz - INTERVAL '14 days'
          AND created_at  < $1::timestamptz + INTERVAL '14 days'
     )
     SELECT
       COUNT(DISTINCT agent_id) FILTER (WHERE created_at <  $1::timestamptz) AS agents_pre,
       COUNT(DISTINCT agent_id) FILTER (WHERE created_at >= $1::timestamptz) AS agents_post,
       COUNT(*) FILTER (WHERE created_at <  $1::timestamptz)                 AS writes_pre,
       COUNT(*) FILTER (WHERE created_at >= $1::timestamptz)                 AS writes_post
       FROM win`,
    [SINCE],
  );
  console.log("\n  ── aggregate");
  printRows(agg);
}

// ─────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await archivalActivityByWeek();
    await archivalByScopeAndType();
    await topActiveAgents();
    await dormantAgents();
    await coreSnapshot();
    await archivalToCoreRatio();
    await beforeAfter();
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
