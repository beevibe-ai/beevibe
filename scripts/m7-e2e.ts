/**
 * M7 multi-process integration smoke.
 *
 * What it tests that m6-e2e CAN'T:
 *   - api + executor spawned as actual `node dist/main.js` subprocesses
 *     (m6-e2e bootstraps both in-process — same Node VM).
 *   - Cross-process IPC: executor's spawned CLI subprocesses hit the api's
 *     real HTTP endpoint (not an in-memory MCP transport).
 *   - Env-var passthrough across processes.
 *   - Signal propagation: parent SIGTERM → graceful child shutdown.
 *   - Orphan-process cleanup after teardown.
 *
 *   RUN_M7_E2E=1 \
 *   DATABASE_URL_TEST=postgresql://... \
 *   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
 *     pnpm tsx scripts/m7-e2e.ts
 *
 * Requires `claude` on PATH and built dist/ for both binaries (the script
 * calls `pnpm build --filter` before spawning so cold runs work).
 */

import { config as loadEnv } from "dotenv";
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
import { PostgresTaskRepository } from "../packages/core/src/adapters/postgres/task-repo.js";
import { createPool, type Pool } from "../packages/core/src/adapters/postgres/client.js";
import type { Task } from "../packages/core/src/domain/task.js";

// ───────────────────────── env ─────────────────────────

const REQUIRED_ENV = [
  "RUN_M7_E2E",
  "DATABASE_URL_TEST",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`✗ M7 E2E: missing env var ${k}`);
    process.exit(1);
  }
}

const TABLES = [
  "escalation",
  "negotiation_round",
  "negotiation",
  "memory_promotion_event",
  "memory_fact",
  "work_product",
  "core_memory_block",
  "session",
  "task",
  "agent",
  "person",
];

const HEALTH_DEADLINE_MS = 15_000;
const TASK_DEADLINE_MS = 90_000;
const SHUTDOWN_DEADLINE_MS = 5_000;

// ───────────────────────── helpers ─────────────────────────

function log(msg: string): void {
  console.log(msg);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`    ✗ ${msg}`);
    process.exit(1);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function getFreePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolveP(port)));
    });
  });
}

async function pollUntil<T>(
  fetch: () => Promise<T | null | undefined>,
  pred: (v: T) => boolean,
  deadlineMs: number,
  tag: string,
): Promise<T> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const v = await fetch();
    if (v != null && pred(v)) return v;
    await sleep(500);
  }
  throw new Error(`pollUntil timed out: "${tag}" (deadline ${deadlineMs}ms)`);
}

async function fetchHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    return res.status === 200;
  } catch {
    return false;
  }
}

async function resetDb(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

/**
 * Spawn a binary as `node dist/main.js`. detached:true puts it in its own
 * process group so we can SIGTERM the whole group at teardown — that's how
 * we propagate shutdown to grandchildren (executor → claude CLI subprocesses).
 *
 * stdio is piped so we can prefix and surface logs in the parent.
 */
function spawnBinary(opts: {
  tag: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): ChildProcessWithoutNullStreams {
  const child = spawn("node", ["dist/main.js"], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const prefix = (chunk: Buffer, stream: "out" | "err"): void => {
    const s = chunk.toString("utf8");
    for (const line of s.split("\n")) {
      if (line.length === 0) continue;
      if (stream === "err") {
        process.stderr.write(`[${opts.tag}] ${line}\n`);
      } else {
        process.stdout.write(`[${opts.tag}] ${line}\n`);
      }
    }
  };

  child.stdout.on("data", (c: Buffer) => prefix(c, "out"));
  child.stderr.on("data", (c: Buffer) => prefix(c, "err"));

  return child;
}

/**
 * SIGTERM the whole process group (kill -pgid). Returns the exit code or
 * throws if the process didn't exit within deadlineMs (caller should
 * SIGKILL in that case — production teardown shouldn't tolerate hangs).
 */
async function shutdownPGroup(
  child: ChildProcess,
  deadlineMs: number,
  tag: string,
): Promise<number> {
  const pid = child.pid;
  if (!pid) throw new Error(`${tag}: child has no pid`);

  const exited = new Promise<number>((resolveP) => {
    child.once("exit", (code, _signal) => {
      resolveP(code ?? -1);
    });
  });

  // Negative pid → process group. detached:true at spawn time made the
  // child its own pgroup leader, so SIGTERM(-pid) reaches the executor's
  // CLI subprocesses too.
  try {
    process.kill(-pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    return 0;
  }

  const winner = await Promise.race([
    exited,
    sleep(deadlineMs).then(() => -2 as const),
  ]);

  if (winner === -2) {
    process.stderr.write(
      `[m7] ${tag} did not exit within ${deadlineMs}ms — SIGKILL\n`,
    );
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // process gone, ok
    }
    throw new Error(`${tag}: graceful shutdown exceeded ${deadlineMs}ms`);
  }

  return winner;
}

/**
 * `pgrep -g <pgid>` — returns true if any process is still alive in the
 * given process group. Used post-shutdown to assert clean teardown.
 */
function pgroupAlive(pgid: number): boolean {
  try {
    // Signal 0 to negative pgid: returns OK if any process in the group
    // exists, throws ESRCH if none.
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ───────────────────────── seed ─────────────────────────

interface Deps {
  pool: Pool;
  persons: PostgresPersonRepository;
  agents: PostgresAgentRepository;
  coreMemoryRepo: PostgresCoreMemoryRepository;
  tasks: PostgresTaskRepository;
}

async function provisionTestData(deps: Deps): Promise<{ task: Task }> {
  const owner = await deps.persons.create({
    id: makePersonId(),
    name: "m7-owner",
  });

  const { agent } = await provisionAgent(
    {
      agentRepo: deps.agents,
      coreMemoryRepo: deps.coreMemoryRepo,
    },
    {
      id: makeAgentId(),
      name: "m7-ic",
      owner_id: owner.id,
      hierarchy_level: "ic",
      // Explicit completion instruction works around the M9-deferred
      // "agent forgets update_progress" footgun (see issue #9, scenario 6).
      // Without this the agent does the work, exits, and we burn a retry
      // session. m7-e2e's whole point is "single happy-path roundtrip" so
      // we want a clean one-session flow.
      runtime_config: {
        ...DEFAULT_RUNTIME_CONFIG,
        system_prompt_addition:
          "When you finish your task, you MUST call the update_progress " +
          "MCP tool with status='done' and a one-sentence summary. " +
          "Do not exit without calling it.",
      },
    },
  );

  const task = await deps.tasks.create({
    id: makeTaskId(),
    title: "m7 smoke task",
    description:
      "Reply with the literal string 'm7-roundtrip-ok'. " +
      "When done, call update_progress(status='done', summary='m7 ok').",
    status: "assigned",
    priority: "medium",
    assignee_id: agent.id,
    creator_id: owner.id,
    creator_type: "person",
  });

  return { task };
}

// ───────────────────────── main ─────────────────────────

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_TEST!;
  const workspaceRoot = mkdtempSync(`${tmpdir()}/beevibe-m7-`);

  const pool = createPool({ connectionString: databaseUrl });
  const deps: Deps = {
    pool,
    persons: new PostgresPersonRepository(pool),
    agents: new PostgresAgentRepository(pool),
    coreMemoryRepo: new PostgresCoreMemoryRepository(pool),
    tasks: new PostgresTaskRepository(pool),
  };

  log("═══ m7-e2e: multi-process integration smoke ═══");
  let api: ChildProcessWithoutNullStreams | undefined;
  let exec: ChildProcessWithoutNullStreams | undefined;

  try {
    log("→ build api + executor (incremental)");
    await new Promise<void>((resolveP, reject) => {
      const child = spawn(
        "pnpm",
        ["-r", "--filter", "@beevibe/api", "--filter", "@beevibe/executor", "build"],
        { cwd: repoRoot, stdio: "inherit" },
      );
      child.on("exit", (code) =>
        code === 0 ? resolveP() : reject(new Error(`build exited ${code}`)),
      );
    });

    log("→ reset test DB + provision");
    await resetDb(pool);
    const { task } = await provisionTestData(deps);
    log(`  task=${task.id} agent=${task.assignee_id}`);

    log("→ pick free ports");
    const apiPort = await getFreePort();
    const executorHealthPort = await getFreePort();
    const apiUrl = `http://localhost:${apiPort}`;
    const mcpUrl = `${apiUrl}/mcp`;
    log(`  api=${apiPort} executor-health=${executorHealthPort}`);

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      BEEVIBE_API_PORT: String(apiPort),
      BEEVIBE_MCP_SERVER_URL: mcpUrl,
      BEEVIBE_EXECUTOR_HEALTH_PORT: String(executorHealthPort),
      WORKSPACE_ROOT: workspaceRoot,
      // Tighten poll interval so the smoke completes faster than dev's 30s.
      POLL_INTERVAL_MS: "2000",
    };

    log("→ spawn api + executor as subprocesses");
    api = spawnBinary({
      tag: "api",
      cwd: resolve(repoRoot, "packages/api"),
      env: childEnv,
    });
    exec = spawnBinary({
      tag: "exec",
      cwd: resolve(repoRoot, "packages/executor"),
      env: childEnv,
    });
    log(`  api pid=${api.pid} exec pid=${exec.pid}`);

    log("→ wait for both health endpoints");
    await pollUntil(
      async () => {
        const [a, e] = await Promise.all([
          fetchHealth(`${apiUrl}/health`),
          fetchHealth(`http://localhost:${executorHealthPort}/health`),
        ]);
        return a && e ? true : null;
      },
      (v) => v === true,
      HEALTH_DEADLINE_MS,
      "both health endpoints 200",
    );
    log("  ✓ api + executor healthy");

    log("→ wait for task done");
    const done = await pollUntil(
      () => deps.tasks.findById(task.id),
      (t) => t.status === "done",
      TASK_DEADLINE_MS,
      `task ${task.id} → done`,
    );
    log(`  ✓ task=${done.id} status=${done.status} summary="${done.result_summary ?? ""}"`);

    log("→ SIGTERM both subprocesses");
    const apiPgid = api.pid!;
    const execPgid = exec.pid!;
    const [apiCode, execCode] = await Promise.all([
      shutdownPGroup(api, SHUTDOWN_DEADLINE_MS, "api"),
      shutdownPGroup(exec, SHUTDOWN_DEADLINE_MS, "exec"),
    ]);
    log(`  api exit=${apiCode} exec exit=${execCode}`);
    assert(apiCode === 0, `api exit code ${apiCode} (expected 0)`);
    assert(execCode === 0, `exec exit code ${execCode} (expected 0)`);

    // Brief settle so any lingering claude grandchildren have a chance to
    // be reaped (their exit signal travels up the tree before we check).
    await sleep(500);

    log("→ verify no orphans in either process group");
    assert(!pgroupAlive(apiPgid), `api pgroup ${apiPgid} still has live processes`);
    assert(!pgroupAlive(execPgid), `exec pgroup ${execPgid} still has live processes`);
    log("  ✓ no orphan processes");

    log("\n═══ ✓ m7-e2e passed ═══");
  } finally {
    // Belt-and-suspenders teardown: if any of the asserts above blew up
    // before the SIGTERM block ran, kill subprocesses now so we don't
    // leak them into the user's shell.
    for (const child of [api, exec]) {
      if (!child || child.exitCode !== null) continue;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await pool.end();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
