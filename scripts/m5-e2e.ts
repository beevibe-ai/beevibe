/**
 * M5 end-to-end smoke for the executor binary. Exercises the full
 * poll → claim → dispatch → session-completion pipeline plus six
 * targeted scenarios that catch integration behavior unit tests can't.
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
 * Scenarios:
 *   0. Happy path — 1 agent, trivial task, full plumbing.
 *   A. Cancel mid-flight — long-running task, cancelTask aborts CLI.
 *   B. Orphan reap — session in DB with dead PID → failed + task re-queued.
 *   C. Revision resume — second session resumes first via --resume
 *      (same cli_session_id, distinct beevibe rows, prior_session_id linked).
 *   D. Priority ordering — critical > medium > low dispatched in that order.
 *   E. Per-agent capacity — max_task_sessions=1 serializes 2 tasks for one agent.
 *   F. Multi-agent parallel — 2 agents each get a task; sessions overlap in time.
 *
 * Deferred to M6 E2E: task.status='done' (update_progress tool),
 * work_product rows (create_work_product tool), memory_fact.source_session_ids
 * content (save_memory tool).
 */

import { config as loadEnv } from "dotenv";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../.env") });

import { bootstrap } from "../packages/executor/src/bootstrap.js";
import { isProcessAlive } from "../packages/executor/src/worker.js";
import {
  agentId as makeAgentId,
  personId as makePersonId,
  sessionId as makeSessionId,
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
import type { Task, TaskPriority } from "../packages/core/src/domain/task.js";

const TABLES = [
  "memory_fact",
  "work_product",
  "core_memory_block",
  "session",
  "task",
  "agent",
  "person",
];

const TRIVIAL_PROMPT = "Reply with the single word 'ok'.";
const LONG_PROMPT =
  "Use the Bash tool to run `sleep 20`. Then reply with just the word 'done'.";

const MCP_URL_UNREACHABLE = "http://localhost:0/";

const TASK_TRANSITION_DEADLINE_MS = 10_000;
const SESSION_TERMINAL_DEADLINE_MS = 90_000;
const PID_POPULATED_DEADLINE_MS = 30_000;

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

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function resetDb(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
}

/**
 * Poll the task until its status matches the predicate or the deadline hits.
 */
async function waitForTask(
  tasks: PostgresTaskRepository,
  id: string,
  deadlineMs: number,
  pred: (t: Task) => boolean,
  tag: string,
): Promise<Task> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const t = await tasks.findById(id);
    if (t && pred(t)) return t;
    await sleep(500);
  }
  const current = await tasks.findById(id);
  throw new Error(`task ${id} never satisfied predicate "${tag}" (last status=${current?.status})`);
}

/**
 * Poll for a session row matching the predicate (latest for task).
 */
async function waitForSession(
  sessions: PostgresSessionRepository,
  taskId: string,
  deadlineMs: number,
  pred: (s: Session) => boolean,
  tag: string,
): Promise<Session> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const s = await sessions.findLatestForTask(taskId);
    if (s && pred(s)) return s;
    await sleep(500);
  }
  const current = await sessions.findLatestForTask(taskId);
  throw new Error(
    `session for task ${taskId} never satisfied predicate "${tag}" (last status=${current?.status})`,
  );
}

type Deps = {
  pool: Pool;
  persons: PostgresPersonRepository;
  agents: PostgresAgentRepository;
  coreMemoryRepo: PostgresCoreMemoryRepository;
  tasks: PostgresTaskRepository;
  sessions: PostgresSessionRepository;
  workspaceRoot: string;
};

type Scenario = (deps: Deps) => Promise<void>;

async function scenario(name: string, fn: Scenario, deps: Deps): Promise<void> {
  log(`\n═══ ${name} ═══`);
  const startedAt = Date.now();
  await resetDb(deps.pool);
  await fn(deps);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`  ✓ ${name}  (${elapsed}s)`);
}

async function bootExecutor(
  deps: Deps,
  opts: { pollIntervalMs?: number; start?: boolean } = {},
): Promise<{
  worker: Awaited<ReturnType<typeof bootstrap>>["worker"];
  shutdown: () => Promise<void>;
}> {
  const { worker, shutdown } = await bootstrap({
    databaseUrl: process.env.DATABASE_URL_TEST!,
    mcpServerUrl: MCP_URL_UNREACHABLE,
    openaiApiKey: process.env.OPENAI_API_KEY!,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    workspaceRoot: deps.workspaceRoot,
    pollIntervalMs: opts.pollIntervalMs ?? 2_000,
  });
  if (opts.start !== false) await worker.start();
  return { worker, shutdown };
}

async function seedOwnerAndAgent(
  deps: Deps,
  agentName: string,
  agentOverrides: Parameters<PostgresAgentRepository["create"]>[0] extends infer A
    ? Partial<Omit<A, "id" | "owner_id">>
    : never = {} as never,
): Promise<{
  ownerId: string;
  agentRecord: Awaited<ReturnType<typeof provisionAgent>>["agent"];
  apiKey: string;
}> {
  const owner = await deps.persons.create({ id: makePersonId(), name: `${agentName}-owner` });
  const { agent, apiKey } = await provisionAgent(
    { agentRepo: deps.agents, coreMemoryRepo: deps.coreMemoryRepo },
    {
      id: makeAgentId(),
      name: agentName,
      owner_id: owner.id,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
      ...agentOverrides,
    },
  );
  return { ownerId: owner.id, agentRecord: agent, apiKey };
}

async function seedTask(
  deps: Deps,
  opts: {
    ownerId: string;
    agentId: string;
    title?: string;
    priority?: TaskPriority;
  },
): Promise<Task> {
  return deps.tasks.create({
    id: makeTaskId(),
    title: opts.title ?? TRIVIAL_PROMPT,
    priority: opts.priority ?? "medium",
    status: "assigned",
    assignee_id: opts.agentId,
    creator_id: opts.ownerId,
    creator_type: "person",
  });
}

// ───────────────────────── scenarios ─────────────────────────

const happyPath: Scenario = async (deps) => {
  const { ownerId, agentRecord, apiKey } = await seedOwnerAndAgent(deps, "happy-agent");
  const task = await seedTask(deps, { ownerId, agentId: agentRecord.id });
  log(`  agent=${agentRecord.id}  task=${task.id}`);

  const { worker, shutdown } = await bootExecutor(deps);
  try {
    await waitForTask(
      deps.tasks,
      task.id,
      TASK_TRANSITION_DEADLINE_MS,
      (t) => t.status === "in_progress" || t.status === "done",
      "assigned→in_progress",
    );
    const session = await waitForSession(
      deps.sessions,
      task.id,
      SESSION_TERMINAL_DEADLINE_MS,
      (s) => s.status === "succeeded" || s.status === "failed",
      "terminal",
    );
    log(`  session=${session.id} status=${session.status} cli_session=${session.cli_session_id}`);
    assert(session.status === "succeeded", `session ended with status=${session.status}`);
    assert(session.cli_session_id, "cli_session_id missing");
    assert(
      session.usage?.input_tokens && session.usage.input_tokens > 0,
      "usage.input_tokens not recorded",
    );
    assert(session.exit_code === 0, `exit_code=${session.exit_code}`);

    const configPath = join(deps.workspaceRoot, agentRecord.id, "mcp-config.json");
    if (process.platform !== "win32") {
      assert(
        (statSync(configPath).mode & 0o777) === 0o600,
        `mcp-config.json mode must be 0600`,
      );
    }
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    assert(
      parsed.mcpServers.beevibe.url === MCP_URL_UNREACHABLE,
      `mcpServerUrl mismatch: ${parsed.mcpServers.beevibe.url}`,
    );
    assert(
      parsed.mcpServers.beevibe.headers.Authorization === `Bearer ${apiKey}`,
      "Authorization header mismatch",
    );
    assert(
      parsed.mcpServers.beevibe.headers["X-Beevibe-Session"] === "${BEEVIBE_SESSION_ID}",
      "X-Beevibe-Session placeholder missing",
    );
  } finally {
    await shutdown();
  }
};

const cancelMidFlight: Scenario = async (deps) => {
  const { ownerId, agentRecord } = await seedOwnerAndAgent(deps, "cancel-agent");
  const task = await seedTask(deps, {
    ownerId,
    agentId: agentRecord.id,
    title: LONG_PROMPT,
  });
  log(`  agent=${agentRecord.id}  task=${task.id}  (long-running prompt: sleep 20)`);

  const { worker, shutdown } = await bootExecutor(deps);
  try {
    // Wait for the CLI subprocess to spawn + onSpawn callback to persist pid.
    const spawned = await waitForSession(
      deps.sessions,
      task.id,
      PID_POPULATED_DEADLINE_MS,
      (s) => s.process_pid !== undefined && s.process_pid !== null,
      "process_pid populated",
    );
    log(`  session=${spawned.id} pid=${spawned.process_pid}`);
    assert(isProcessAlive(spawned.process_pid), "CLI should be alive before cancel");

    // Fire cancel.
    const aborted = await worker.cancelTask(task.id);
    assert(aborted, "cancelTask should return true for in-flight task");

    // Session transitions to cancelled once AbortController chain propagates.
    const final = await waitForSession(
      deps.sessions,
      task.id,
      30_000,
      (s) => s.status === "cancelled" || s.status === "failed",
      "terminal after cancel",
    );
    log(`  post-cancel session status=${final.status}`);
    assert(final.status === "cancelled", `expected cancelled, got ${final.status}`);

    // PID should be dead (SIGTERM/KILL via spawn.ts).
    await sleep(1_000);
    assert(
      !isProcessAlive(final.process_pid),
      `CLI pid ${final.process_pid} still alive after cancel`,
    );
  } finally {
    await shutdown();
  }
};

const orphanReap: Scenario = async (deps) => {
  const { ownerId, agentRecord } = await seedOwnerAndAgent(deps, "orphan-agent");
  const task = await seedTask(deps, { ownerId, agentId: agentRecord.id });
  // Pre-create an orphaned session row with a fake dead PID. This represents
  // the state after an executor crash: session=running, PID points to a
  // process that no longer exists. Real-CLI-death variant is racy because
  // AgentSession would write the terminal state before reap sees it.
  const orphan = await deps.sessions.create({
    id: makeSessionId(),
    agent_id: agentRecord.id,
    task_id: task.id,
    type: "task",
    intent: TRIVIAL_PROMPT,
    process_pid: 99_999_999,
    process_group_id: 99_999_999,
    status: "running",
    started_at: new Date(),
  });
  await deps.tasks.update(task.id, { status: "in_progress" });
  log(`  orphan session=${orphan.id} with fake dead pid=99_999_999`);

  const { worker, shutdown } = await bootExecutor(deps);
  try {
    // start() ran one poll immediately → reap detected the orphan.
    const reread = await deps.sessions.findById(orphan.id);
    assert(reread?.status === "failed", `expected failed, got ${reread?.status}`);
    assert(reread?.error === "process_lost", `expected process_lost error, got ${reread?.error}`);
    log(`  orphan reaped → status=${reread?.status} error=${reread?.error}`);

    // Task re-queued, then re-dispatched. Wait for the FOLLOWING session to succeed.
    const followup = await waitForSession(
      deps.sessions,
      task.id,
      SESSION_TERMINAL_DEADLINE_MS,
      (s) => s.id !== orphan.id && (s.status === "succeeded" || s.status === "failed"),
      "re-dispatched session terminal",
    );
    log(`  re-dispatched session=${followup.id} status=${followup.status}`);
    assert(
      followup.status === "succeeded",
      `re-dispatched session ended with status=${followup.status}`,
    );
  } finally {
    await shutdown();
  }
};

const revisionResume: Scenario = async (deps) => {
  const { ownerId, agentRecord } = await seedOwnerAndAgent(deps, "revision-agent");
  const task = await seedTask(deps, { ownerId, agentId: agentRecord.id });
  log(`  agent=${agentRecord.id}  task=${task.id}`);

  const { worker, shutdown } = await bootExecutor(deps);
  try {
    // First run.
    const first = await waitForSession(
      deps.sessions,
      task.id,
      SESSION_TERMINAL_DEADLINE_MS,
      (s) => s.status === "succeeded" || s.status === "failed",
      "first session terminal",
    );
    assert(first.status === "succeeded", `first session status=${first.status}`);
    assert(first.cli_session_id, "first cli_session_id missing");
    log(`  first session=${first.id} cli=${first.cli_session_id}`);

    // Queue task for re-work. Worker's next poll picks it up; claimById
    // transitions needs_revision → revision before dispatching.
    await deps.tasks.update(task.id, { status: "needs_revision" });

    const second = await waitForSession(
      deps.sessions,
      task.id,
      SESSION_TERMINAL_DEADLINE_MS,
      (s) => s.id !== first.id && (s.status === "succeeded" || s.status === "failed"),
      "second session terminal",
    );
    assert(second.status === "succeeded", `second session status=${second.status}`);
    log(`  second session=${second.id} cli=${second.cli_session_id}`);

    // Verify task reached status="revision" during re-work dispatch — this
    // is the semantic distinction the needs_revision ↔ revision split
    // preserves.
    const taskDuringOrAfterRework = await deps.tasks.findById(task.id);
    assert(
      taskDuringOrAfterRework?.status === "revision",
      `task.status during re-work should be "revision", got "${taskDuringOrAfterRework?.status}"`,
    );

    // Core assertions: CLI session was resumed (same id), DB rows are
    // distinct, and prior_session_id links them.
    assert(second.id !== first.id, "second session must be a new beevibe row");
    assert(
      second.cli_session_id === first.cli_session_id,
      `cli_session_id changed: first=${first.cli_session_id} second=${second.cli_session_id} (expected same — --resume keeps same ID)`,
    );
    assert(
      second.prior_session_id === first.id,
      `prior_session_id mismatch: expected ${first.id}, got ${second.prior_session_id}`,
    );
  } finally {
    await shutdown();
  }
};

const priorityOrdering: Scenario = async (deps) => {
  // Three different agents so cap=1 doesn't serialize dispatch. Observe
  // claim order via task.updated_at: claimById sets `updated_at = NOW()` and
  // the worker for-loop awaits each claim sequentially, so these timestamps
  // reflect dispatch order (unlike session.started_at, which is set after
  // an awaited DB lookup inside AgentSession.run and races between parallel
  // dispatches).
  const a1 = await seedOwnerAndAgent(deps, "p-low-agent");
  const a2 = await seedOwnerAndAgent(deps, "p-critical-agent");
  const a3 = await seedOwnerAndAgent(deps, "p-medium-agent");
  const low = await seedTask(deps, {
    ownerId: a1.ownerId,
    agentId: a1.agentRecord.id,
    priority: "low",
  });
  const critical = await seedTask(deps, {
    ownerId: a2.ownerId,
    agentId: a2.agentRecord.id,
    priority: "critical",
  });
  const medium = await seedTask(deps, {
    ownerId: a3.ownerId,
    agentId: a3.agentRecord.id,
    priority: "medium",
  });
  log(`  tasks seeded: critical=${critical.id} medium=${medium.id} low=${low.id}`);

  const { worker, shutdown } = await bootExecutor(deps);
  try {
    // Wait for all three claims to land (task status → in_progress).
    const claimedCritical = await waitForTask(
      deps.tasks,
      critical.id,
      TASK_TRANSITION_DEADLINE_MS,
      (t) => t.status === "in_progress",
      "critical claimed",
    );
    const claimedMedium = await waitForTask(
      deps.tasks,
      medium.id,
      TASK_TRANSITION_DEADLINE_MS,
      (t) => t.status === "in_progress",
      "medium claimed",
    );
    const claimedLow = await waitForTask(
      deps.tasks,
      low.id,
      TASK_TRANSITION_DEADLINE_MS,
      (t) => t.status === "in_progress",
      "low claimed",
    );
    log(
      `  claimed_at (updated_at): critical=${claimedCritical.updated_at.toISOString()} medium=${claimedMedium.updated_at.toISOString()} low=${claimedLow.updated_at.toISOString()}`,
    );
    assert(
      claimedCritical.updated_at.getTime() <= claimedMedium.updated_at.getTime(),
      `critical should be claimed before medium`,
    );
    assert(
      claimedMedium.updated_at.getTime() <= claimedLow.updated_at.getTime(),
      `medium should be claimed before low`,
    );

    // Wait for all three to reach terminal state so we clean shutdown without
    // leaving child claude processes behind.
    for (const [name, id] of [
      ["critical", critical.id],
      ["medium", medium.id],
      ["low", low.id],
    ] as const) {
      const s = await waitForSession(
        deps.sessions,
        id,
        SESSION_TERMINAL_DEADLINE_MS,
        (s) => s.status === "succeeded" || s.status === "failed",
        `${name} terminal`,
      );
      assert(s.status === "succeeded", `${name} session status=${s.status}`);
    }
  } finally {
    await shutdown();
  }
};

const perAgentCapacity: Scenario = async (deps) => {
  // Same agent, cap=1 (default). Two tasks seeded; second must wait for first.
  const { ownerId, agentRecord } = await seedOwnerAndAgent(deps, "cap-agent");
  const t1 = await seedTask(deps, { ownerId, agentId: agentRecord.id, title: TRIVIAL_PROMPT });
  const t2 = await seedTask(deps, { ownerId, agentId: agentRecord.id, title: TRIVIAL_PROMPT });
  log(`  agent=${agentRecord.id}  tasks=[${t1.id}, ${t2.id}]`);

  const { worker, shutdown } = await bootExecutor(deps);
  try {
    const s1 = await waitForSession(
      deps.sessions,
      t1.id,
      SESSION_TERMINAL_DEADLINE_MS,
      (s) => s.status === "succeeded" || s.status === "failed",
      "task1 terminal",
    );
    const s2 = await waitForSession(
      deps.sessions,
      t2.id,
      SESSION_TERMINAL_DEADLINE_MS,
      (s) => s.status === "succeeded" || s.status === "failed",
      "task2 terminal",
    );
    assert(s1.status === "succeeded" && s2.status === "succeeded", "both sessions should succeed");
    log(`  t1 started=${s1.started_at?.toISOString()} completed=${s1.completed_at?.toISOString()}`);
    log(`  t2 started=${s2.started_at?.toISOString()} completed=${s2.completed_at?.toISOString()}`);

    // Capacity gate should have serialized: t2.started_at >= t1.completed_at.
    assert(s1.completed_at, "session 1 missing completed_at");
    assert(
      s2.started_at!.getTime() >= s1.completed_at!.getTime(),
      `capacity gate did NOT serialize: t2.started_at (${s2.started_at?.toISOString()}) before t1.completed_at (${s1.completed_at?.toISOString()})`,
    );
  } finally {
    await shutdown();
  }
};

const multiAgentParallel: Scenario = async (deps) => {
  // Two distinct agents → cap gate never blocks. Both sessions should run
  // simultaneously, so their time intervals overlap.
  const a1 = await seedOwnerAndAgent(deps, "par-agent-1");
  const a2 = await seedOwnerAndAgent(deps, "par-agent-2");
  const t1 = await seedTask(deps, { ownerId: a1.ownerId, agentId: a1.agentRecord.id });
  const t2 = await seedTask(deps, { ownerId: a2.ownerId, agentId: a2.agentRecord.id });
  log(`  agents=[${a1.agentRecord.id}, ${a2.agentRecord.id}]  tasks=[${t1.id}, ${t2.id}]`);

  const { worker, shutdown } = await bootExecutor(deps);
  try {
    const s1 = await waitForSession(
      deps.sessions,
      t1.id,
      SESSION_TERMINAL_DEADLINE_MS,
      (s) => s.status === "succeeded" || s.status === "failed",
      "task1 terminal",
    );
    const s2 = await waitForSession(
      deps.sessions,
      t2.id,
      SESSION_TERMINAL_DEADLINE_MS,
      (s) => s.status === "succeeded" || s.status === "failed",
      "task2 terminal",
    );
    assert(s1.status === "succeeded" && s2.status === "succeeded", "both sessions should succeed");
    log(`  t1 [${s1.started_at?.toISOString()}, ${s1.completed_at?.toISOString()}]`);
    log(`  t2 [${s2.started_at?.toISOString()}, ${s2.completed_at?.toISOString()}]`);

    assert(s1.completed_at && s2.completed_at, "both sessions must have completed_at");
    // Intervals overlap: each starts before the other ends.
    const overlap =
      s1.started_at!.getTime() < s2.completed_at!.getTime() &&
      s2.started_at!.getTime() < s1.completed_at!.getTime();
    assert(
      overlap,
      `sessions did not overlap in time — dispatch was serialized instead of parallel`,
    );
  } finally {
    await shutdown();
  }
};

// ───────────────────────── entry ─────────────────────────

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
  const deps: Deps = {
    pool,
    persons: new PostgresPersonRepository(pool),
    agents: new PostgresAgentRepository(pool),
    coreMemoryRepo: new PostgresCoreMemoryRepository(pool),
    tasks: new PostgresTaskRepository(pool),
    sessions: new PostgresSessionRepository(pool),
    workspaceRoot,
  };

  const overall = Date.now();
  try {
    await scenario("0. happy path", happyPath, deps);
    await scenario("A. cancel mid-flight", cancelMidFlight, deps);
    await scenario("B. orphan reap", orphanReap, deps);
    await scenario("C. revision resume", revisionResume, deps);
    await scenario("D. priority ordering", priorityOrdering, deps);
    await scenario("E. per-agent capacity", perAgentCapacity, deps);
    await scenario("F. multi-agent parallel", multiAgentParallel, deps);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    await pool.end();
  }
  const totalSec = ((Date.now() - overall) / 1000).toFixed(1);
  log(`\n✓ M5 E2E complete (all 7 scenarios, ${totalSec}s total)`);
}

main().catch((err: unknown) => {
  console.error("\n✗ M5 E2E failed:", err);
  process.exit(1);
});
