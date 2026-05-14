/**
 * Demo seeder for the M7 manual smoke flow.
 *
 * Targets the *dev* DB (DATABASE_URL) — same DB the running `pnpm dev`
 * api+scheduler are connected to. Provisions a fixed topology so a human
 * can connect their own Claude Code CLI via the cloudflared tunnel +
 * bv_u_ token and exercise the MCP tool surface:
 *
 *     person:   demo-user (bv_u_<token>)
 *       └── captain  (team-tier, owned by demo-user) ← bv_u_ resolves here
 *             ├── ic-alice (ic-tier)
 *             └── ic-bob   (ic-tier)
 *
 * Usage:
 *   pnpm tsx scripts/provision-demo.ts            # idempotent create + print
 *   pnpm tsx scripts/provision-demo.ts --print    # re-print existing keys
 *   pnpm tsx scripts/provision-demo.ts --clean    # wipe demo rows (no reseed)
 *
 * The paste-ready mcp.json snippet uses the tunnel URL written to
 * ~/.beevibe/last-tunnel-url by `scripts/dev.sh` if present, else
 * falls back to http://localhost:3000.
 */

import { config as loadEnv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import { agentId as makeAgentId, personId as makePersonId } from "../packages/core/src/domain/ids.js";
import { DEFAULT_RUNTIME_CONFIG } from "../packages/core/src/domain/agent.js";
import {
  provisionAgent,
  provisionUser,
} from "../packages/core/src/auth/provision.js";
import { PostgresAgentRepository } from "../packages/core/src/adapters/postgres/agent-repo.js";
import { PostgresCoreMemoryRepository } from "../packages/core/src/adapters/postgres/core-memory-repo.js";
import { PostgresPersonRepository } from "../packages/core/src/adapters/postgres/person-repo.js";
import { createPool, type Pool } from "../packages/core/src/adapters/postgres/client.js";
import type { Agent } from "../packages/core/src/domain/agent.js";
import type { Person } from "../packages/core/src/domain/person.js";

const DEMO_PERSON_NAME = "demo-user";
const DEMO_CAPTAIN_NAME = "captain";
const DEMO_IC_NAMES = ["ic-alice", "ic-bob"] as const;

const TUNNEL_URL_FILE = join(homedir(), ".beevibe", "last-tunnel-url");
const DEFAULT_API_URL = "http://localhost:3000";

// ───────────────────────── helpers ─────────────────────────

/**
 * Mirrors `packages/scheduler/src/worker.ts:isProcessAlive`. EPERM means the
 * pid exists but in another uid — treat as alive to avoid spurious "safe
 * to clean" verdicts. ESRCH (or any other errno) means the process is gone.
 */
function isProcessAlive(pid: number | null | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function readTunnelUrl(): string {
  try {
    if (existsSync(TUNNEL_URL_FILE)) {
      const url = readFileSync(TUNNEL_URL_FILE, "utf8").trim();
      if (url.startsWith("http")) return url;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_API_URL;
}

function printSnippet(opts: {
  apiUrl: string;
  bvUToken: string;
  captain: Agent;
  ics: Agent[];
}): void {
  const { apiUrl, bvUToken, captain, ics } = opts;
  const bar = "━".repeat(64);
  console.log("");
  console.log(bar);
  console.log("Demo topology:");
  console.log(`  person:   ${DEMO_PERSON_NAME}`);
  console.log(`  └── ${captain.name}  (team-tier, your auth identity)  id=${captain.id}`);
  for (const ic of ics) {
    console.log(`        ├── ${ic.name}  (ic-tier)  id=${ic.id}`);
  }
  console.log("");
  console.log(`bv_u_ token:  ${bvUToken}`);
  console.log(`api URL:      ${apiUrl}`);
  console.log("");
  console.log("Paste into ~/.config/claude/mcp.json (or your local Claude mcp config):");
  console.log("");
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          beevibe: {
            type: "http",
            url: `${apiUrl}/mcp`,
            headers: { Authorization: `Bearer ${bvUToken}` },
          },
        },
      },
      null,
      2,
    ),
  );
  console.log("");
  console.log("Then run `claude` in any directory and try:");
  console.log("  - \"who are my subordinates?\"");
  console.log("  - \"create a task for ic-alice: write a hello-world bash script\"");
  console.log("  - \"what's the status of that task?\"");
  console.log("");
  console.log(`To clean up:  pnpm tsx scripts/provision-demo.ts --clean`);
  console.log(bar);
}

// ───────────────────────── lookup ─────────────────────────

async function findDemoPerson(pool: Pool): Promise<Person | undefined> {
  const { rows } = await pool.query<Person>(
    `SELECT * FROM person WHERE name = $1 LIMIT 1`,
    [DEMO_PERSON_NAME],
  );
  return rows[0];
}

async function findDemoAgents(
  pool: Pool,
  ownerId: string,
): Promise<{ captain?: Agent; ics: Agent[] }> {
  const { rows } = await pool.query<Agent>(
    `SELECT * FROM agent WHERE owner_id = $1 ORDER BY hierarchy_level DESC, name ASC`,
    [ownerId],
  );
  const captain = rows.find((a) => a.name === DEMO_CAPTAIN_NAME);
  const ics = rows.filter((a) => DEMO_IC_NAMES.includes(a.name as (typeof DEMO_IC_NAMES)[number]));
  return { captain, ics };
}

// ───────────────────────── create ─────────────────────────

async function createDemo(pool: Pool): Promise<{
  bvUToken: string;
  captain: Agent;
  ics: Agent[];
}> {
  const persons = new PostgresPersonRepository(pool);
  const agents = new PostgresAgentRepository(pool);
  const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);

  const { person, apiKey: bvUToken } = await provisionUser(
    { personRepo: persons },
    { id: makePersonId(), name: DEMO_PERSON_NAME },
  );

  const { agent: captain } = await provisionAgent(
    { agentRepo: agents, coreMemoryRepo },
    {
      id: makeAgentId(),
      name: DEMO_CAPTAIN_NAME,
      owner_id: person.id,
      hierarchy_level: "team",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    },
  );

  const icResults = await Promise.all(
    DEMO_IC_NAMES.map((name) =>
      provisionAgent(
        { agentRepo: agents, coreMemoryRepo },
        {
          id: makeAgentId(),
          name,
          owner_id: person.id,
          parent_agent_id: captain.id,
          hierarchy_level: "ic",
          runtime_config: DEFAULT_RUNTIME_CONFIG,
        },
      ),
    ),
  );
  const ics: Agent[] = icResults.map((r) => r.agent);

  return { bvUToken, captain, ics };
}

// ───────────────────────── clean ─────────────────────────

async function cleanDemoData(pool: Pool): Promise<void> {
  const person = await findDemoPerson(pool);
  if (!person) {
    console.log("No demo data found — nothing to clean.");
    return;
  }

  const { rows: agentRows } = await pool.query<{ id: string }>(
    `SELECT id FROM agent WHERE owner_id = $1`,
    [person.id],
  );
  const agentIds = agentRows.map((r) => r.id);

  if (agentIds.length === 0) {
    // Person row exists but no agents — just delete the person.
    await pool.query(`DELETE FROM person WHERE id = $1`, [person.id]);
    console.log(`Cleaned demo person (no agents found).`);
    return;
  }

  // Safety: refuse only if a session has a *live* OS process backing it.
  // Sessions stuck at status='running' after `pnpm dev` was killed
  // ungracefully have no live process — those are safe to wipe. Chat
  // sessions never had a process_pid (they ride the api's lifetime), so
  // they're treated as dead too.
  const { rows: liveRows } = await pool.query<{
    id: string;
    process_pid: number | null;
  }>(
    `SELECT id, process_pid FROM session
      WHERE agent_id = ANY($1::text[]) AND status = 'running'`,
    [agentIds],
  );
  const trulyLive = liveRows.filter(
    (r) => r.process_pid !== null && isProcessAlive(r.process_pid),
  );
  if (trulyLive.length > 0) {
    console.error(
      `✗ Refusing to clean: ${trulyLive.length} demo session(s) have live OS ` +
        `processes (pids: ${trulyLive.map((r) => r.process_pid).join(", ")}). ` +
        `Stop pnpm dev (or wait for tasks to settle) and retry.`,
    );
    process.exit(1);
  }
  if (liveRows.length > 0) {
    console.log(
      `(${liveRows.length} stale 'running' session row(s) detected — cleaning anyway since their processes are gone.)`,
    );
  }

  await pool.query("BEGIN");
  try {
    // Order matters — delete things that reference others first.
    //
    // FK-CASCADE chains we rely on (don't need explicit deletes):
    //   negotiation        → negotiation_round       (CASCADE)
    //   memory_fact        → memory_promotion_event  (CASCADE)
    //   agent              → core_memory_block       (CASCADE)
    //   agent              → memory_fact             (CASCADE)
    //   task               → work_product            (CASCADE)
    //
    // FKs without CASCADE — we delete explicitly:
    //   escalation         → session, negotiation
    //   negotiation        → agent, session, task
    //   memory_promotion_event → agent (origin)
    //   task               → agent (assignee/creator/blocker), task (parent), person
    //   session            → agent, task, session (prior)
    //   agent              → person, agent (parent)

    await pool.query(
      `DELETE FROM escalation
        WHERE initiator_session_id IN (SELECT id FROM session WHERE agent_id = ANY($1::text[]))
           OR counterparty_session_id IN (SELECT id FROM session WHERE agent_id = ANY($1::text[]))`,
      [agentIds],
    );

    await pool.query(
      `DELETE FROM negotiation
        WHERE initiator_agent_id = ANY($1::text[])
           OR counterparty_agent_id = ANY($1::text[])`,
      [agentIds],
    );

    await pool.query(
      `DELETE FROM memory_promotion_event
        WHERE origin_agent_id = ANY($1::text[])`,
      [agentIds],
    );

    // session.task_id forces sessions before tasks; prior_session_id self-FK forces null-first.
    await pool.query(
      `UPDATE session SET prior_session_id = NULL WHERE agent_id = ANY($1::text[])`,
      [agentIds],
    );
    await pool.query(`DELETE FROM session WHERE agent_id = ANY($1::text[])`, [agentIds]);

    // Tasks form a self-referential tree. Build the closure of demo-related
    // tasks (assignee/creator in demo set OR descendant of one of those),
    // null out parent_task_id within the closure to break the self-FK, then
    // delete the closure. work_product CASCADEs.
    const { rows: taskRows } = await pool.query<{ id: string }>(
      `WITH RECURSIVE demo_tasks AS (
         SELECT id FROM task
          WHERE assignee_id = ANY($1::text[])
             OR (creator_type = 'agent' AND creator_id = ANY($1::text[]))
             OR (creator_type = 'person' AND creator_id = $2)
         UNION
         SELECT t.id FROM task t
           JOIN demo_tasks dt ON t.parent_task_id = dt.id
       )
       SELECT id FROM demo_tasks`,
      [agentIds, person.id],
    );
    if (taskRows.length > 0) {
      const taskIds = taskRows.map((r) => r.id);
      await pool.query(
        `UPDATE task SET parent_task_id = NULL WHERE id = ANY($1::text[])`,
        [taskIds],
      );
      await pool.query(`DELETE FROM task WHERE id = ANY($1::text[])`, [taskIds]);
    }

    await pool.query(
      `UPDATE agent SET parent_agent_id = NULL WHERE id = ANY($1::text[])`,
      [agentIds],
    );
    await pool.query(`DELETE FROM agent WHERE owner_id = $1`, [person.id]);

    await pool.query(`DELETE FROM person WHERE id = $1`, [person.id]);

    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }

  console.log(
    `Cleaned demo data (person=${person.name}, ${agentIds.length} agent(s)).`,
  );
}

// ───────────────────────── main ─────────────────────────

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const flagPrint = args.has("--print");
  const flagClean = args.has("--clean");

  if (flagPrint && flagClean) {
    console.error("✗ --print and --clean are mutually exclusive");
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error(
      "✗ DATABASE_URL not set. Make sure .env exists at the repo root and contains DATABASE_URL.",
    );
    process.exit(1);
  }

  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  try {
    if (flagClean) {
      await cleanDemoData(pool);
      return;
    }

    const existing = await findDemoPerson(pool);
    if (existing) {
      const { captain, ics } = await findDemoAgents(pool, existing.id);
      if (!captain) {
        console.error(
          `✗ Found ${DEMO_PERSON_NAME} but no '${DEMO_CAPTAIN_NAME}' agent. DB is in an inconsistent state. Run --clean and retry.`,
        );
        process.exit(1);
      }
      const apiUrl = readTunnelUrl();
      printSnippet({ apiUrl, bvUToken: existing.api_key!, captain, ics });
      return;
    }

    if (flagPrint) {
      console.error(`✗ No demo data found. Run without --print to create it.`);
      process.exit(1);
    }

    const { bvUToken, captain, ics } = await createDemo(pool);
    const apiUrl = readTunnelUrl();
    printSnippet({ apiUrl, bvUToken, captain, ics });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
