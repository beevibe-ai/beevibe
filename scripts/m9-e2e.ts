/**
 * M9 e2e — proves skills land + change agent behavior end-to-end.
 *
 * What's covered here (vs unit tests):
 *   - Skill sync to <workspace>/.claude/skills/ at dispatch (scenario 1)
 *   - M7 footgun fix: dispatched agent calls update_progress WITHOUT the
 *     system_prompt_addition workaround m7-e2e uses; proves the
 *     beevibe-task-completion skill changes real LLM behavior (scenario 6)
 *   - Cache hit ratio: second session's cache_read_input_tokens > 0,
 *     validating M9.4's briefing restructure cache optimization (scenario 9)
 *
 * What's NOT here (already covered by unit tests):
 *   - Filesystem sync mechanics (sync.test.ts)
 *   - install-skills idempotency / namespace (install-skills.test.ts)
 *   - IC negotiation server rejection (mesh.test.ts)
 *   - Workspace integration mechanics (manager.test.ts)
 *
 * Usage:
 *   RUN_M9_E2E=1 \
 *   DATABASE_URL_TEST=postgresql://... \
 *   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... \
 *     pnpm tsx scripts/m9-e2e.ts
 *
 * Requires `claude` on PATH and built dist/ for both binaries.
 */

import { config as loadEnv } from "dotenv";
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { PostgresSessionRepository } from "../packages/core/src/adapters/postgres/session-repo.js";
import { PostgresTaskRepository } from "../packages/core/src/adapters/postgres/task-repo.js";
import { createPool, type Pool } from "../packages/core/src/adapters/postgres/client.js";
import type { Session } from "../packages/core/src/domain/session.js";
import type { Task } from "../packages/core/src/domain/task.js";

// ───────────────────────── env ─────────────────────────

const REQUIRED_ENV = [
  "RUN_M9_E2E",
  "DATABASE_URL_TEST",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`✗ M9 E2E: missing env var ${k}`);
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
const CACHE_HIT_RATIO_THRESHOLD = 0.5; // conservative; M9.4 should hit >0.7 in practice

// ───────────────────────── helpers ─────────────────────────

function log(msg: string): void {
  console.log(msg);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    // Throw instead of process.exit(1) so the script's `finally` block
    // (kills subprocesses + rmSync workspace) actually runs. Otherwise
    // stale api/executor processes survive failures and intercept the
    // next run's tasks with their old workspace root.
    throw new Error(msg);
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
  fetchFn: () => Promise<T | null | undefined>,
  pred: (v: T) => boolean,
  deadlineMs: number,
  tag: string,
): Promise<T> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const v = await fetchFn();
    if (v != null && pred(v)) return v;
    await sleep(500);
  }
  throw new Error(`pollUntil timed out: "${tag}" (deadline ${deadlineMs}ms)`);
}

async function fetchHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function resetDb(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

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
      if (stream === "err") process.stderr.write(`[${opts.tag}] ${line}\n`);
      else process.stdout.write(`[${opts.tag}] ${line}\n`);
    }
  };

  child.stdout.on("data", (c: Buffer) => prefix(c, "out"));
  child.stderr.on("data", (c: Buffer) => prefix(c, "err"));

  return child;
}

async function shutdownPGroup(
  child: ChildProcess,
  deadlineMs: number,
  tag: string,
): Promise<number> {
  const pid = child.pid;
  if (!pid) throw new Error(`${tag}: child has no pid`);

  const exited = new Promise<number>((resolveP) => {
    child.once("exit", (code) => resolveP(code ?? -1));
  });

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
    process.stderr.write(`[m9] ${tag} did not exit within ${deadlineMs}ms — SIGKILL\n`);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // gone
    }
    throw new Error(`${tag}: graceful shutdown exceeded ${deadlineMs}ms`);
  }

  return winner;
}

// ───────────────────────── seed ─────────────────────────

interface Deps {
  pool: Pool;
  persons: PostgresPersonRepository;
  agents: PostgresAgentRepository;
  coreMemoryRepo: PostgresCoreMemoryRepository;
  tasks: PostgresTaskRepository;
  sessions: PostgresSessionRepository;
}

async function provisionAgentNoWorkaround(
  deps: Deps,
  ownerId: string,
  name: string,
): Promise<{ agentId: string }> {
  // Critical: NO system_prompt_addition workaround. The skill alone is
  // expected to teach the agent to call update_progress. If the agent
  // forgets, the M7 footgun fires (two sessions per task) and we fail
  // scenario 6.
  const { agent } = await provisionAgent(
    {
      agentRepo: deps.agents,
      coreMemoryRepo: deps.coreMemoryRepo,
    },
    {
      id: makeAgentId(),
      name,
      owner_id: ownerId,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    },
  );
  return { agentId: agent.id };
}

async function dispatchTask(
  deps: Deps,
  ownerId: string,
  agentId: string,
  description: string,
): Promise<Task> {
  return deps.tasks.create({
    id: makeTaskId(),
    title: "m9 smoke",
    description,
    status: "assigned",
    priority: "medium",
    assignee_id: agentId,
    creator_id: ownerId,
    creator_type: "person",
  });
}

// ───────────────────────── scenarios ─────────────────────────

async function scenarioOne_skillsInWorkspace(
  workspaceRoot: string,
  agentId: string,
): Promise<void> {
  log("→ Scenario 1: skill sync at workspace creation");
  const skillsDir = join(workspaceRoot, agentId, ".claude", "skills");
  assert(
    existsSync(skillsDir),
    `expected skills dir at ${skillsDir} (workspace not synced?)`,
  );
  const dirs = readdirSync(skillsDir).sort();
  log(`  found ${dirs.length} skills: ${dirs.join(", ")}`);
  // IC tier: 8 universal skills.
  assert(dirs.length === 8, `expected 8 IC-tier skills, got ${dirs.length}`);
  assert(dirs.includes("beevibe"), "umbrella skill missing");
  assert(dirs.includes("beevibe-task-completion"), "task-completion skill missing");
  assert(
    !dirs.includes("beevibe-team-mesh-negotiation"),
    "team-only skill leaked into IC workspace",
  );
  log("  ✓ IC tier sees 8 universal skills, no team-only leakage");
}

async function scenarioSix_oneSessionPerTask(
  deps: Deps,
  taskId: string,
): Promise<Session[]> {
  log("→ Scenario 6: M7 footgun fix — one session per leaf task");
  // Read all sessions for this task. Without the task-completion skill,
  // we'd see TWO (original + M6.5 nudge_completion retry).
  const result = await deps.pool.query<Session>(
    `SELECT * FROM session WHERE task_id = $1 ORDER BY started_at ASC`,
    [taskId],
  );
  log(`  found ${result.rows.length} session(s) for task ${taskId}`);
  for (const s of result.rows) {
    log(`    session ${s.id} status=${s.status} intent=${s.intent.slice(0, 60).replace(/\n/g, " ")}…`);
  }
  assert(
    result.rows.length === 1,
    `expected 1 session per leaf task; got ${result.rows.length} (M7 footgun?)`,
  );
  log("  ✓ exactly one session — beevibe-task-completion skill is doing its job");
  return result.rows;
}

async function scenarioNine_cacheHitRatio(
  deps: Deps,
  agentId: string,
): Promise<void> {
  log("→ Scenario 9: cache hit ratio on second session");

  // Race: task.status flips to 'done' when the agent calls update_progress
  // (mid-CLI), but session.status + session.usage are written by agent-
  // session step 5 AFTER the CLI subprocess exits and runtime.execute
  // returns. Poll until the agent has 2 terminal sessions with usage.
  const sessions = await pollUntil(
    async () => {
      const r = await deps.pool.query<Session>(
        `SELECT * FROM session WHERE agent_id = $1 ORDER BY started_at ASC`,
        [agentId],
      );
      const allTerminalWithUsage = r.rows.every(
        (s) => s.status !== "running" && s.usage != null,
      );
      return r.rows.length >= 2 && allTerminalWithUsage ? r.rows : null;
    },
    (rows) => rows.length >= 2,
    30_000,
    "≥2 terminal sessions with usage populated",
  );

  const second = sessions[1]!;
  const usage = second.usage!;
  log(
    `  session_2 usage: input=${usage.input_tokens}, ` +
      `cache_read=${usage.cache_read_input_tokens}, ` +
      `cache_creation=${usage.cache_creation_input_tokens}`,
  );

  // Anthropic's three input counters are DISJOINT slices of the same
  // prompt: input_tokens (new, uncached) + cache_creation (written to
  // cache) + cache_read (read from cache) = total input. Cache hit ratio
  // = cache_read / total. The M9.4 target is >0.7 — most of a stable
  // prompt should land via cache_read on the second-onward session.
  const inputTokens = usage.input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const totalInput = inputTokens + cacheCreation + cacheRead;
  assert(totalInput > 0, `session_2 has zero total input tokens (CLI usage parse may be broken)`);
  const ratio = cacheRead / totalInput;
  log(
    `  cache hit ratio = ${cacheRead} / (${inputTokens} + ${cacheCreation} + ${cacheRead}) ` +
      `= ${cacheRead} / ${totalInput} = ${(ratio * 100).toFixed(1)}%`,
  );
  assert(
    ratio > CACHE_HIT_RATIO_THRESHOLD,
    `cache hit ratio ${(ratio * 100).toFixed(1)}% below threshold ${(CACHE_HIT_RATIO_THRESHOLD * 100).toFixed(0)}% — M9.4 briefing restructure not delivering`,
  );
  log(`  ✓ cache hit ratio above threshold (target >${(CACHE_HIT_RATIO_THRESHOLD * 100).toFixed(0)}%)`);
}

// ───────────────────────── main ─────────────────────────

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_TEST!;
  const workspaceRoot = mkdtempSync(`${tmpdir()}/beevibe-m9-`);

  const pool = createPool({ connectionString: databaseUrl });
  const deps: Deps = {
    pool,
    persons: new PostgresPersonRepository(pool),
    agents: new PostgresAgentRepository(pool),
    coreMemoryRepo: new PostgresCoreMemoryRepository(pool),
    tasks: new PostgresTaskRepository(pool),
    sessions: new PostgresSessionRepository(pool),
  };

  log("═══ m9-e2e: skills + cache integration smoke ═══");
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

    log("→ reset test DB + provision (NO system_prompt_addition workaround)");
    await resetDb(pool);
    const owner = await deps.persons.create({ id: makePersonId(), name: "m9-owner" });
    const { agentId } = await provisionAgentNoWorkaround(deps, owner.id, "m9-ic");
    log(`  agent=${agentId}`);

    log("→ pick free ports");
    const apiPort = await getFreePort();
    const executorHealthPort = await getFreePort();
    const apiUrl = `http://localhost:${apiPort}`;
    const mcpUrl = `${apiUrl}/mcp`;

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      BEEVIBE_API_PORT: String(apiPort),
      BEEVIBE_MCP_SERVER_URL: mcpUrl,
      BEEVIBE_EXECUTOR_HEALTH_PORT: String(executorHealthPort),
      WORKSPACE_ROOT: workspaceRoot,
      // Skills source is the repo's /skills/ dir.
      BEEVIBE_SKILLS_DIR: resolve(repoRoot, "skills"),
      POLL_INTERVAL_MS: "2000",
    };

    log("→ spawn api + executor");
    api = spawnBinary({ tag: "api", cwd: resolve(repoRoot, "packages/api"), env: childEnv });
    exec = spawnBinary({ tag: "exec", cwd: resolve(repoRoot, "packages/executor"), env: childEnv });
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

    log("→ dispatch task #1");
    const task1 = await dispatchTask(
      deps,
      owner.id,
      agentId,
      "Reply with the literal string 'm9-task1-ok'.",
    );
    log(`  task=${task1.id}`);

    log("→ wait for task #1 done");
    await pollUntil(
      () => deps.tasks.findById(task1.id),
      (t) => t.status === "done",
      TASK_DEADLINE_MS,
      `task ${task1.id} → done`,
    );
    log("  ✓ task #1 done");

    // Scenario 1: skill sync happened at workspace creation.
    await scenarioOne_skillsInWorkspace(workspaceRoot, agentId);

    // Scenario 6: ONE session for task #1.
    await scenarioSix_oneSessionPerTask(deps, task1.id);

    log("→ dispatch task #2 (within cache window)");
    const task2 = await dispatchTask(
      deps,
      owner.id,
      agentId,
      "Reply with the literal string 'm9-task2-ok'.",
    );
    log(`  task=${task2.id}`);

    log("→ wait for task #2 done");
    await pollUntil(
      () => deps.tasks.findById(task2.id),
      (t) => t.status === "done",
      TASK_DEADLINE_MS,
      `task ${task2.id} → done`,
    );
    log("  ✓ task #2 done");

    // Scenario 9: cache_read_input_tokens > 0 on second session.
    await scenarioNine_cacheHitRatio(deps, agentId);

    log("→ SIGTERM both subprocesses");
    const [apiCode, execCode] = await Promise.all([
      shutdownPGroup(api, SHUTDOWN_DEADLINE_MS, "api"),
      shutdownPGroup(exec, SHUTDOWN_DEADLINE_MS, "exec"),
    ]);
    log(`  api exit=${apiCode} exec exit=${execCode}`);

    log("\n═══ ✓ m9-e2e passed (scenarios 1, 6, 9) ═══");
    log("\nUnit-test coverage for the others:");
    log("  - sync.test.ts (10): mtime/size diff, namespace safety, idempotent re-run");
    log("  - install-skills.test.ts (11): validation + install + idempotency + namespace");
    log("  - manager.test.ts (4 added): IC vs team filter, re-sync propagation, namespace");
    log("  - mesh.test.ts (4): IC tier inventory + drop respond_negotiate (M9.1 guardrail)");
  } finally {
    for (const child of [api, exec]) {
      if (!child || child.exitCode !== null) continue;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // gone
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
