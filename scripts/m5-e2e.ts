/**
 * M5 end-to-end smoke for the executor binary. Exercises the full
 * poll → claim → dispatch → session-completion pipeline against live
 * infrastructure.
 *
 * Requires:
 * - `RUN_M5_E2E=1`
 * - `DATABASE_URL_TEST` — pgvector-enabled Postgres (M0 schema + all migrations)
 * - `OPENAI_API_KEY` — embeddings for briefing retrieval
 * - `ANTHROPIC_API_KEY` — memory LLM (FactPromoter, FactStore merge)
 * - `claude` CLI on PATH (M2 runtime dependency)
 *
 * Usage:
 *   RUN_M5_E2E=1 pnpm tsx scripts/m5-e2e.ts
 *
 * What it does:
 *   1. Truncate test DB.
 *   2. Create a person + IC agent via provisionAgent.
 *   3. Create an assigned task for the agent with a trivial prompt.
 *   4. Boot the executor (mcpServerUrl points at localhost:0 — unreachable;
 *      the prompt needs no tools so the session still completes).
 *   5. worker.start() and poll the DB until the task transitions and the
 *      session reaches a terminal state (up to ~90s).
 *   6. Assert:
 *      - Task went assigned → in_progress (claimed by the worker).
 *      - Session row exists, status=succeeded, cli_session_id non-empty,
 *        usage.input_tokens > 0, exit_code=0.
 *      - mcp-config.json was written with mode 0o600 and correct contents
 *        (Bearer token + ${BEEVIBE_SESSION_ID} placeholder + url).
 *   7. worker.stop() + shutdown() + cleanup workspace.
 *
 * Explicitly deferred to M6 E2E: task.status='done' (needs update_progress
 * tool), work_product rows (needs create_work_product tool),
 * memory_fact.source_session_ids assertions (needs save_memory tool).
 */

import { config as loadEnv } from "dotenv";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import { bootstrap } from "../packages/executor/src/bootstrap.js";
import { agentId, personId, taskId } from "../packages/core/src/domain/ids.js";
import { DEFAULT_RUNTIME_CONFIG } from "../packages/core/src/domain/agent.js";
import { provisionAgent } from "../packages/core/src/auth/provision.js";
import { PostgresAgentRepository } from "../packages/core/src/adapters/postgres/agent-repo.js";
import { PostgresCoreMemoryRepository } from "../packages/core/src/adapters/postgres/core-memory-repo.js";
import { PostgresPersonRepository } from "../packages/core/src/adapters/postgres/person-repo.js";
import { PostgresSessionRepository } from "../packages/core/src/adapters/postgres/session-repo.js";
import { PostgresTaskRepository } from "../packages/core/src/adapters/postgres/task-repo.js";
import { createPool } from "../packages/core/src/adapters/postgres/client.js";

const TABLES = [
  "memory_fact",
  "work_product",
  "core_memory_block",
  "session",
  "task",
  "agent",
  "person",
];

const TASK_TRANSITION_DEADLINE_MS = 10_000;
const SESSION_SUCCESS_DEADLINE_MS = 90_000;

function step(n: number, title: string): void {
  console.log(`\n━━━ ${n}. ${title}`);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`ASSERTION FAILED: ${msg}`);
    process.exit(1);
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  if (process.env.RUN_M5_E2E !== "1") {
    console.log("Set RUN_M5_E2E=1 to run this script.");
    process.exit(0);
  }

  const dbUrl = process.env.DATABASE_URL_TEST;
  assert(dbUrl, "DATABASE_URL_TEST must be set");
  assert(process.env.OPENAI_API_KEY, "OPENAI_API_KEY must be set");
  assert(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY must be set");

  const pool = createPool({ connectionString: dbUrl, max: 4 });
  const workspaceRoot = mkdtempSync(join(tmpdir(), "beevibe-m5-e2e-"));

  try {
    step(1, "Truncate test DB");
    await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);

    step(2, "Create person + IC agent via provisionAgent");
    const persons = new PostgresPersonRepository(pool);
    const agents = new PostgresAgentRepository(pool);
    const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
    const tasks = new PostgresTaskRepository(pool);
    const sessions = new PostgresSessionRepository(pool);

    const owner = await persons.create({ id: personId(), name: "M5 Owner" });
    const { agent, apiKey } = await provisionAgent(
      { agentRepo: agents, coreMemoryRepo },
      {
        id: agentId(),
        name: "M5 IC",
        owner_id: owner.id,
        hierarchy_level: "ic",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    console.log(`   agent ${agent.id}, api_key ${apiKey.slice(0, 10)}…`);
    assert(apiKey.startsWith("bv_a_"), "agent key should have bv_a_ prefix");

    step(3, "Seed assigned task for the agent");
    const createdTask = await tasks.create({
      id: taskId(),
      title: "Reply with the single word 'ok'.",
      priority: "medium",
      status: "assigned",
      assignee_id: agent.id,
      creator_id: owner.id,
      creator_type: "person",
    });
    console.log(`   task ${createdTask.id}`);

    step(4, "Boot executor");
    // Unreachable MCP URL is intentional: the trivial prompt needs no tools.
    // M6 E2E will hit a real MCP server.
    const { worker, shutdown } = await bootstrap({
      databaseUrl: dbUrl,
      mcpServerUrl: "http://localhost:0/",
      openaiApiKey: process.env.OPENAI_API_KEY!,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
      workspaceRoot,
      pollIntervalMs: 2_000, // tight loop for E2E responsiveness
    });

    step(5, "worker.start()");
    await worker.start();

    try {
      step(6, "Wait for claim transition (task: assigned → in_progress)");
      const transitionStart = Date.now();
      let inProgress = false;
      while (Date.now() - transitionStart < TASK_TRANSITION_DEADLINE_MS) {
        const t = await tasks.findById(createdTask.id);
        if (t?.status === "in_progress" || t?.status === "done") {
          inProgress = true;
          break;
        }
        await wait(500);
      }
      assert(
        inProgress,
        `task did not transition to in_progress within ${TASK_TRANSITION_DEADLINE_MS}ms`,
      );

      step(7, "Wait for a succeeded session row on the task");
      const sessionStart = Date.now();
      let finalSession = null as Awaited<ReturnType<typeof sessions.findLatestForTask>>;
      while (Date.now() - sessionStart < SESSION_SUCCESS_DEADLINE_MS) {
        const s = await sessions.findLatestForTask(createdTask.id);
        if (s && (s.status === "succeeded" || s.status === "failed")) {
          finalSession = s;
          break;
        }
        await wait(1_000);
      }
      assert(
        finalSession,
        `no terminal session row appeared within ${SESSION_SUCCESS_DEADLINE_MS}ms`,
      );
      console.log(
        `   session ${finalSession.id} → status=${finalSession.status}, cli_session=${finalSession.cli_session_id}`,
      );
      assert(
        finalSession.status === "succeeded",
        `session ended with status=${finalSession.status} (expected succeeded)`,
      );
      assert(finalSession.cli_session_id, "cli_session_id missing");
      assert(
        finalSession.usage?.input_tokens && finalSession.usage.input_tokens > 0,
        "usage.input_tokens not recorded",
      );
      assert(
        finalSession.exit_code === 0,
        `exit_code=${finalSession.exit_code} (expected 0)`,
      );
    } finally {
      step(8, "worker.stop() + shutdown()");
      await shutdown();
    }

    step(9, "Assert mcp-config.json on disk has correct contents + mode");
    const configPath = join(workspaceRoot, agent.id, "mcp-config.json");
    const mode = statSync(configPath).mode & 0o777;
    if (process.platform !== "win32") {
      assert(mode === 0o600, `mcp-config.json mode=${mode.toString(8)} (expected 600)`);
    }
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    assert(
      parsed.mcpServers.beevibe.url === "http://localhost:0/",
      `unexpected mcpServerUrl in config: ${parsed.mcpServers.beevibe.url}`,
    );
    assert(
      parsed.mcpServers.beevibe.headers.Authorization === `Bearer ${apiKey}`,
      "Authorization header mismatch",
    );
    assert(
      parsed.mcpServers.beevibe.headers["X-Beevibe-Session"] === "${BEEVIBE_SESSION_ID}",
      "X-Beevibe-Session placeholder missing or wrong",
    );

    console.log("\n✓ M5 E2E complete");
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("\n✗ M5 E2E failed:", err);
  process.exit(1);
});
