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
const TASK_DEADLINE_MS = 180_000; // multi-round negotiations + code-task git ops
const SHUTDOWN_DEADLINE_MS = 15_000; // 5s was tight when 4+ agents are running
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
  opts: { repo_url?: string; title?: string } = {},
): Promise<Task> {
  return deps.tasks.create({
    id: makeTaskId(),
    title: opts.title ?? "m9 smoke",
    description,
    status: "assigned",
    priority: "medium",
    assignee_id: agentId,
    creator_id: ownerId,
    creator_type: "person",
    repo_url: opts.repo_url,
  });
}

/**
 * Read all Claude Code JSONL transcript files for a workspace and count
 * Skill tool invocations. Used to determine if a given skill is actually
 * firing in its target scenario.
 *
 * The JSONL path encoding: Claude Code writes per-cwd transcripts at
 * ~/.claude/projects/<encoded-cwd>/<cli_session_id>.jsonl, where
 * encoded-cwd replaces / with -.
 */
async function countSkillInvocations(workspaceDir: string): Promise<{
  totalSkillCalls: number;
  perSkill: Record<string, number>;
}> {
  const { readdir, readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");

  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  // Resolve symlinks (macOS /var → /private/var) to match Claude Code's
  // encoded path format. realpath returns canonical path.
  const { realpath } = await import("node:fs/promises");
  let canonical: string;
  try {
    canonical = await realpath(workspaceDir);
  } catch {
    canonical = workspaceDir;
  }
  // Claude Code encodes the cwd by replacing `/` AND `_` with `-`. So
  // `/private/var/folders/.../agent_X` → `-private-var-folders-...-agent-X`.
  const encodedCwd = canonical.replace(/[/_]/g, "-");

  const projectDirs = await readdir(claudeProjectsDir).catch(() => []);
  const matchingDir = projectDirs.find((d) => d.endsWith(encodedCwd));
  if (!matchingDir) {
    return { totalSkillCalls: 0, perSkill: {} };
  }

  const sessionDir = join(claudeProjectsDir, matchingDir);
  const sessionFiles = (await readdir(sessionDir)).filter((f) => f.endsWith(".jsonl"));

  const perSkill: Record<string, number> = {};
  let totalSkillCalls = 0;

  // Walk the JSON tree of each line looking for { name: "Skill",
  // input: { skill: "..." } } anywhere — handles nested message.content
  // arrays, content_block payloads, etc. without fragile regex.
  function findSkillCalls(node: unknown, out: string[]): void {
    if (Array.isArray(node)) {
      for (const item of node) findSkillCalls(item, out);
      return;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (
        obj.name === "Skill" &&
        obj.input &&
        typeof obj.input === "object" &&
        typeof (obj.input as Record<string, unknown>).skill === "string"
      ) {
        out.push((obj.input as Record<string, string>).skill);
      }
      for (const v of Object.values(obj)) findSkillCalls(v, out);
    }
  }

  for (const file of sessionFiles) {
    const content = await readFile(join(sessionDir, file), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const skills: string[] = [];
      findSkillCalls(parsed, skills);
      for (const skillName of skills) {
        const normalized = skillName.replace(/^\//, "");
        totalSkillCalls += 1;
        perSkill[normalized] = (perSkill[normalized] ?? 0) + 1;
      }
    }
  }

  return { totalSkillCalls, perSkill };
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
  // IC tier: 5 universal skills. Three "always-on" skills removed in M9
  // empirical validation (their content moved into BEEVIBE_LIFECYCLE_REMINDER
  // + BEEVIBE_MEMORY_REMINDER injected by AgentSession into the system
  // prompt): beevibe (umbrella), beevibe-task-completion, beevibe-memory-
  // management.
  assert(dirs.length === 5, `expected 5 IC-tier skills, got ${dirs.length}`);
  assert(dirs.includes("beevibe-pre-task-setup"), "pre-task-setup skill missing");
  assert(
    !dirs.includes("beevibe-team-mesh-negotiation"),
    "team-only skill leaked into IC workspace",
  );
  log("  ✓ IC tier sees 5 universal skills, no team-only leakage");
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
  log("  ✓ exactly one session — BEEVIBE_LIFECYCLE_REMINDER reliably triggers update_progress");
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

    // ── Scenario 10: skill firing — beevibe-pre-task-setup ──
    log("→ Scenario 10: dispatch task with repo_url; check pre-task-setup skill firing");
    const codeTask = await dispatchTask(
      deps,
      owner.id,
      agentId,
      "Inspect the repo at the given URL — what files are in the repo root? List them.",
      {
        title: "m9 smoke — code task with repo_url",
        repo_url: "https://github.com/octocat/Hello-World.git",
      },
    );
    log(`  task=${codeTask.id} repo_url=https://github.com/octocat/Hello-World.git`);
    await pollUntil(
      async () => {
        const t = await deps.tasks.findById(codeTask.id);
        return t && (t.status === "done" || t.status === "failed") ? t : null;
      },
      (t) => t.status === "done" || t.status === "failed",
      TASK_DEADLINE_MS,
      `task ${codeTask.id} → done|failed`,
    );

    // ── Scenario 11: skill firing — beevibe-work-product-decision ──
    log("→ Scenario 11: deliverable-shaped task; check work-product-decision firing");
    const wpTask = await dispatchTask(
      deps,
      owner.id,
      agentId,
      "Read the README.md inside the cloned Hello-World repo (already on disk from " +
        "the previous task) and record what you find as an analysis-type work-product " +
        "for this task. The summary should describe the README contents in 1-2 " +
        "sentences. Always check existing work-products for this task first to avoid " +
        "duplicates.",
      {
        title: "m9 smoke — record analysis as work-product",
        repo_url: "https://github.com/octocat/Hello-World.git",
      },
    );
    log(`  task=${wpTask.id} (expects work-product-decision skill to fire)`);
    await pollUntil(
      async () => {
        const t = await deps.tasks.findById(wpTask.id);
        return t && (t.status === "done" || t.status === "failed") ? t : null;
      },
      (t) => t.status === "done" || t.status === "failed",
      TASK_DEADLINE_MS,
      `task ${wpTask.id} → done|failed`,
    );

    // ── Scenario 12: skill firing — beevibe-mesh-ask-responder ──
    // Need a SECOND agent (the ask target). Provision one mid-test, then
    // dispatch a task to our existing agent that requires asking the new
    // one. Both agents must be team-tier or higher for `ask` to work in
    // the existing agent's tool set... wait, IC has respond_ask too. So
    // the asker must be team (has `ask`), and the target can be IC.
    // For simplicity here, both can be team — `ask` works peer-to-peer.
    log("→ Scenario 12: provision peer agent; ask flow → mesh-ask-responder firing");
    const peerOwner = owner; // share owner
    const { agentId: peerAgentId } = await provisionAgentNoWorkaround(deps, peerOwner.id, "m9-peer");
    log(`  peer agent=${peerAgentId}`);
    // Dispatch to the ORIGINAL agent (which is IC tier; ICs DON'T have
    // `ask`). We need a TEAM agent to call ask. Provision a third agent
    // that's team-tier to be the asker.
    const { agent: askerAgent } = await provisionAgent(
      {
        agentRepo: deps.agents,
        coreMemoryRepo: deps.coreMemoryRepo,
      },
      {
        id: makeAgentId(),
        name: "m9-asker",
        owner_id: owner.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    log(`  asker agent=${askerAgent.id} (team-tier, has 'ask' tool)`);
    const askTask = await dispatchTask(
      deps,
      owner.id,
      askerAgent.id,
      `Use the mcp__beevibe__ask tool to ask agent_id="${peerAgentId}" the literal ` +
        `question "what is your agent_id?". When you receive the answer, include it ` +
        `verbatim in your update_progress summary.`,
      { title: "m9 smoke — ask peer for their id" },
    );
    log(`  task=${askTask.id} (asker → peer)`);
    await pollUntil(
      async () => {
        const t = await deps.tasks.findById(askTask.id);
        return t && (t.status === "done" || t.status === "failed") ? t : null;
      },
      (t) => t.status === "done" || t.status === "failed",
      TASK_DEADLINE_MS,
      `task ${askTask.id} → done|failed`,
    );

    // ── Scenario 13: skill firing — beevibe-team-mesh-negotiation ──
    log("→ Scenario 13: provision second team peer; negotiation flow → mesh-negotiation firing");
    const { agent: negPeer } = await provisionAgent(
      {
        agentRepo: deps.agents,
        coreMemoryRepo: deps.coreMemoryRepo,
      },
      {
        id: makeAgentId(),
        name: "m9-neg-peer",
        owner_id: owner.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    log(`  negotiation peer agent=${negPeer.id} (team-tier)`);
    const negTask = await dispatchTask(
      deps,
      owner.id,
      askerAgent.id,
      `You need to coordinate a project split with peer agent_id="${negPeer.id}". ` +
        `Propose: you handle the API changes; the peer handles the UI updates, both ` +
        `landing by Friday. Use mcp__beevibe__negotiate(peer_id="${negPeer.id}", ` +
        `proposal="...") to start. If the peer counters, work toward a mutually ` +
        `acceptable plan over up to 3 rounds. Then update_progress with the final ` +
        `agreement (or failure reason).`,
      { title: "m9 smoke — negotiate split with team peer" },
    );
    log(`  task=${negTask.id} (asker → negotiation peer)`);
    await pollUntil(
      async () => {
        const t = await deps.tasks.findById(negTask.id);
        return t && (t.status === "done" || t.status === "failed") ? t : null;
      },
      (t) => t.status === "done" || t.status === "failed",
      TASK_DEADLINE_MS,
      `task ${negTask.id} → done|failed`,
    );

    // ── Survey: ALL skill invocations across all sessions of all agents ──
    log("→ Survey: skill auto-discovery firing across all sessions, all agents");
    const allInvocations: Record<string, number> = {};
    for (const aid of [agentId, peerAgentId, askerAgent.id, negPeer.id]) {
      const wsDir = join(workspaceRoot, aid);
      const inv = await countSkillInvocations(wsDir);
      log(`  ${aid}: ${inv.totalSkillCalls} Skill calls`);
      for (const [name, count] of Object.entries(inv.perSkill)) {
        log(`    ${name}: ${count}`);
        allInvocations[name] = (allInvocations[name] ?? 0) + count;
      }
    }
    log("");
    log(`  Aggregate per-skill invocations:`);
    if (Object.keys(allInvocations).length === 0) {
      log(`    (none — all skills appear to be dead weight)`);
    } else {
      for (const [name, count] of Object.entries(allInvocations).sort()) {
        log(`    ${name}: ${count}`);
      }
    }

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
