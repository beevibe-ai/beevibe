/**
 * M12c real-daemon TASK e2e — proves a code task dispatched through
 * dispatchService is claimed by the daemon (not the executor) and
 * runs end-to-end with the universal `beevibe-pre-task-setup` skill
 * auto-firing. Mirrors m9's scenario 10 but the spawn happens in the
 * daemon path instead of in-process.
 *
 * What's covered (vs m9 scenario 10 / m12b):
 *   - dispatchService.dispatchTask({type:'task'}) inserts a pending
 *     session bound to the agent's preferred_runtime_id.
 *   - Daemon claims via /runtime/claim (NOT the in-process executor).
 *   - Real claude spawns with --append-system-prompt carrying
 *     BEEVIBE_LIFECYCLE_REMINDER + briefing → agent calls
 *     update_progress on exit.
 *   - The pre-task-setup skill auto-fires on a code task (repo_url
 *     drives the trigger phrase) — proves daemon-side
 *     LocalWorkspaceManager actually synced .claude/skills/.
 *   - Hello-World-* worktree exists in the daemon's workspace dir
 *     (skill body's naming convention followed end-to-end).
 *
 * Usage:
 *   RUN_M12C_E2E=1 \
 *   DATABASE_URL_TEST=postgresql://... \
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
 *     pnpm tsx scripts/m12c-task-daemon-e2e.ts
 */

import { config as loadEnv } from "dotenv";
import { spawn, type ChildProcess, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresPersonRepository,
  PostgresSessionRepository,
  PostgresTaskRepository,
  createPool,
} from "../packages/core/src/adapters/postgres/index.js";
import { provisionAgent, provisionUser } from "../packages/core/src/auth/provision.js";
import { DispatchService } from "../packages/core/src/services/dispatch-service.js";
import { buildIntent } from "../packages/core/src/services/agent-session.js";
import { bootstrap as bootstrapApi } from "../packages/api/src/bootstrap.js";

if (process.env.RUN_M12C_E2E !== "1") {
  console.error("✗ M12C E2E: missing env var RUN_M12C_E2E");
  process.exit(1);
}

const DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL_TEST or DATABASE_URL required");
if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY required for the live claude turn");
}

const TASK_DEADLINE_MS = 240_000; // code task is heavier than chat
const SHUTDOWN_DEADLINE_MS = 5_000;

function log(s: string): void {
  console.log(s);
}

async function applyMigrations(): Promise<void> {
  execSync(`DATABASE_URL=${DATABASE_URL} pnpm migrate up`, {
    stdio: "ignore",
    cwd: repoRoot,
  });
}

async function truncateAll(): Promise<void> {
  const pool = createPool({ connectionString: DATABASE_URL! });
  await pool.query(
    `TRUNCATE TABLE
       session_event, session, task, escalation,
       negotiation_round, negotiation, work_product,
       memory_promotion_event, memory_fact, core_memory_block,
       runtime, daemon, agent, person
     RESTART IDENTITY CASCADE`,
  );
  await pool.end();
}

async function getFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
  });
}

function shutdown(child: ChildProcess, label: string): Promise<number> {
  return new Promise((res) => {
    if (child.exitCode !== null) {
      res(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      log(`  [${label}] graceful timeout — sending SIGKILL`);
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, SHUTDOWN_DEADLINE_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      res(code ?? 0);
    });
    child.kill("SIGTERM");
  });
}

async function buildDaemonDist(): Promise<void> {
  log("→ build daemon dist/");
  await new Promise<void>((res, rej) => {
    const child = spawn(
      "pnpm",
      ["-r", "--filter", "@beevibe/daemon", "build"],
      { cwd: repoRoot, stdio: "inherit" },
    );
    child.on("exit", (code) =>
      code === 0 ? res() : rej(new Error(`daemon build exited ${code}`)),
    );
  });
}

async function pollUntil<T>(
  fn: () => Promise<T | undefined | null>,
  predicate: (v: T) => boolean,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v && predicate(v)) return v;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`timeout waiting for: ${label}`);
}

/**
 * Read the per-cwd Claude Code transcript for `workspaceDir` and count
 * Skill tool invocations. Lifted (and slimmed) from m9-e2e.ts —
 * Claude Code writes ~/.claude/projects/<encoded-cwd>/<sid>.jsonl
 * where encoded-cwd replaces / and _ with -.
 */
async function countSkillInvocations(workspaceDir: string): Promise<{
  total: number;
  perSkill: Record<string, number>;
}> {
  const { readdir, readFile, realpath } = await import("node:fs/promises");
  const claudeProjectsDir = join(homedir(), ".claude", "projects");
  let canonical: string;
  try {
    canonical = await realpath(workspaceDir);
  } catch {
    return { total: 0, perSkill: {} };
  }
  const encodedCwd = canonical.replace(/[/_]/g, "-");
  const projectDirs = await readdir(claudeProjectsDir).catch(() => []);
  const matching = projectDirs.find((d) => d.endsWith(encodedCwd));
  if (!matching) return { total: 0, perSkill: {} };

  const sessionDir = join(claudeProjectsDir, matching);
  const sessionFiles = (await readdir(sessionDir)).filter((f) =>
    f.endsWith(".jsonl"),
  );

  const perSkill: Record<string, number> = {};
  let total = 0;
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
      for (const s of skills) {
        const norm = s.replace(/^\//, "");
        total += 1;
        perSkill[norm] = (perSkill[norm] ?? 0) + 1;
      }
    }
  }
  return { total, perSkill };
}

async function main(): Promise<void> {
  await applyMigrations();
  await truncateAll();
  await buildDaemonDist();

  const apiPort = await getFreePort();
  const apiUrl = `http://localhost:${apiPort}`;
  log(`→ api on ${apiPort}`);

  const apiBootstrap = await bootstrapApi({
    databaseUrl: DATABASE_URL!,
    openaiApiKey: process.env.OPENAI_API_KEY ?? "test",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    mcpServerUrl: `${apiUrl}/mcp`,
    port: apiPort,
  });
  await apiBootstrap.server.start();
  log("  ✓ api booted");

  // Isolate workspaces (daemon spawns claude in here) + ~/.beevibe.
  const realHome = homedir();
  const beevibeDir = join(realHome, ".beevibe");
  const backupDir = join(tmpdir(), `beevibe-m12c-backup-${Date.now()}`);
  let backedUp = false;
  if (existsSync(beevibeDir)) {
    execSync(`mv "${beevibeDir}" "${backupDir}"`, { stdio: "ignore" });
    backedUp = true;
    log(`→ backed up ~/.beevibe to ${backupDir}`);
  }
  const tmpWorkspaceRoot = mkdtempSync(join(tmpdir(), "beevibe-m12c-ws-"));
  log(`→ workspace root → ${tmpWorkspaceRoot}`);

  let daemon: ChildProcess | undefined;
  try {
    const pool = createPool({ connectionString: DATABASE_URL! });
    const personRepo = new PostgresPersonRepository(pool);
    const agentRepo = new PostgresAgentRepository(pool);
    const taskRepo = new PostgresTaskRepository(pool);
    const sessionRepo = new PostgresSessionRepository(pool);
    const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);

    const alice = await provisionUser(
      { personRepo },
      { id: makePersonId(), name: "Alice", email: "alice-m12c@example.com" },
    );
    const team = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: makeAgentId(),
        name: "Alice's Team Agent",
        owner_id: alice.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    log("  ✓ seeded alice + team agent");

    // ── daemon setup ────────────────────────────────────────────────
    log("→ daemon setup");
    const daemonMain = resolve(repoRoot, "packages/daemon/dist/main.js");
    await new Promise<void>((res, rej) => {
      const child = spawn(
        process.execPath,
        [
          daemonMain,
          "setup",
          "--api",
          apiUrl,
          "--user-token",
          alice.apiKey,
          "--external-id",
          "m12c-mock",
          "--device-name",
          "m12c-test",
        ],
        { env: process.env, stdio: "inherit" },
      );
      child.on("exit", (code) =>
        code === 0 ? res() : rej(new Error(`setup exited ${code}`)),
      );
    });
    log("  ✓ daemon setup complete");

    // Bind agent → runtime so dispatch sets runtime_id and the daemon
    // (not the executor) wins the claim.
    const { rows: runtimeRows } = await pool.query<{ id: string }>(
      `SELECT r.id FROM runtime r JOIN daemon d ON d.id = r.daemon_id
       WHERE d.owner_person_id = $1 AND r.cli = 'claude'`,
      [alice.person.id],
    );
    if (runtimeRows.length === 0) {
      throw new Error("expected runtime row for alice's daemon");
    }
    const boundRuntimeId = runtimeRows[0]!.id;
    await agentRepo.update(team.agent.id, {
      preferred_runtime_id: boundRuntimeId,
    });
    log(`  ✓ agent bound to runtime ${boundRuntimeId}`);

    // ── daemon start ────────────────────────────────────────────────
    log("→ daemon start");
    daemon = spawn(process.execPath, [daemonMain, "start"], {
      env: { ...process.env, WORKSPACE_ROOT: tmpWorkspaceRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout?.on("data", (b) =>
      process.stdout.write(`  [daemon] ${b.toString()}`),
    );
    daemon.stderr?.on("data", (b) =>
      process.stderr.write(`  [daemon] ${b.toString()}`),
    );
    await new Promise((r) => setTimeout(r, 1500));

    // ── dispatch a code task through dispatchService ────────────────
    // Mirror m9 scenario 10's prompt: edit README + commit on a per-
    // task branch. The repo_url drives `pre-task-setup` skill auto-
    // fire; the worktree-naming convention exercises the skill body.
    log("→ dispatch code task via dispatchService");
    const dispatchService = new DispatchService({
      agentRepo,
      sessionRepo,
      taskRepo,
    });
    const taskRow = await taskRepo.create({
      id: makeTaskId(),
      title: "m12c smoke — edit README, commit on per-task branch",
      description:
        "Append the literal line 'edited by m12c smoke' to the end of " +
        "the README in this repo, commit the change on a dedicated " +
        "per-task branch, then report the branch name and commit SHA " +
        "in your update_progress summary.",
      status: "assigned",
      priority: "medium",
      assignee_id: team.agent.id,
      creator_id: alice.person.id,
      creator_type: "person",
      repo_url: "https://github.com/octocat/Hello-World.git",
    });
    const reason = { kind: "fresh" as const };
    const dispatchResult = await dispatchService.dispatchTask({
      task: taskRow,
      agentId: team.agent.id,
      intent: buildIntent(
        { id: taskRow.id, title: taskRow.title, description: taskRow.description },
        reason,
      ),
      reason,
      type: "task",
    });
    log(
      `  task=${taskRow.id} session=${dispatchResult.session.id} runtime=${
        dispatchResult.runtime_id ?? "(server-fallback)"
      }`,
    );
    if (dispatchResult.runtime_id !== boundRuntimeId) {
      throw new Error(
        `expected dispatch to pin runtime_id=${boundRuntimeId}, got ${dispatchResult.runtime_id}`,
      );
    }

    // ── wait for task done|failed ───────────────────────────────────
    const finalTask = await pollUntil(
      () => taskRepo.findById(taskRow.id),
      (t) => t.status === "done" || t.status === "failed",
      TASK_DEADLINE_MS,
      `task ${taskRow.id} → done|failed`,
    );
    log(`  ✓ task ${finalTask.id} status=${finalTask.status}`);
    if (finalTask.status !== "done") {
      const sess = await sessionRepo.findLatestForTask(taskRow.id);
      throw new Error(
        `expected task done; got ${finalTask.status}. ` +
          `last session: ${JSON.stringify({
            id: sess?.id,
            status: sess?.status,
            error: sess?.error,
            result_summary: sess?.result_summary?.slice(0, 200),
          })}`,
      );
    }

    // ── ONE session for this task (no retry / no double-spawn) ─────
    const sessions = await sessionRepo.listForTask(taskRow.id);
    if (sessions.length !== 1) {
      throw new Error(`expected 1 session for task; got ${sessions.length}`);
    }
    const sessionRow = sessions[0]!;
    if (sessionRow.runtime_id !== boundRuntimeId) {
      throw new Error(
        `expected session.runtime_id=${boundRuntimeId}, got ${sessionRow.runtime_id} ` +
          `(daemon path didn't run; executor or fallback claimed instead?)`,
      );
    }
    log(
      `  ✓ exactly 1 session, runtime_id=${sessionRow.runtime_id} (daemon claim)`,
    );

    // ── pre-task-setup skill auto-fired ─────────────────────────────
    const wsDir = join(tmpWorkspaceRoot, team.agent.id);
    const inv = await countSkillInvocations(wsDir);
    const ptsCount = inv.perSkill["beevibe-pre-task-setup"] ?? 0;
    log(`  pre-task-setup invocations: ${ptsCount}`);
    if (ptsCount < 1) {
      throw new Error(
        `expected pre-task-setup to auto-fire on a code-with-repo_url task; ` +
          `got 0 invocations. perSkill=${JSON.stringify(inv.perSkill)}`,
      );
    }
    log(`  ✓ pre-task-setup auto-fired (${ptsCount}x)`);

    // ── worktree convention followed ────────────────────────────────
    const worktrees = readdirSync(wsDir).filter((d) =>
      d.startsWith("Hello-World-"),
    );
    if (worktrees.length === 0) {
      throw new Error(
        `expected ≥1 Hello-World-* worktree from pre-task-setup; got 0 ` +
          `(workspace dir contents: ${readdirSync(wsDir).join(", ")})`,
      );
    }
    log(`  ✓ Hello-World-* worktree present: ${worktrees.join(", ")}`);

    // ── skills materialized in workspace ────────────────────────────
    const skillsDir = join(wsDir, ".claude", "skills");
    for (const name of [
      "beevibe-pre-task-setup",
      "beevibe-team-mesh-negotiation",
    ]) {
      const skill = join(skillsDir, name, "SKILL.md");
      if (!existsSync(skill)) {
        throw new Error(`expected ${name}/SKILL.md at ${skill}`);
      }
    }
    log(`  ✓ skills present in workspace (universal + team-tier)`);

    // ── update_progress fired ───────────────────────────────────────
    if (!finalTask.result_summary || finalTask.result_summary.length === 0) {
      throw new Error("expected task.result_summary set by update_progress");
    }
    log(
      `  ✓ update_progress recorded summary (${finalTask.result_summary.length} chars)`,
    );

    await pool.end();
    log("\n✓ M12C e2e: daemon TASK round-trip + pre-task-setup auto-fire passed");
  } finally {
    if (daemon) {
      log("→ shutdown daemon");
      const code = await shutdown(daemon, "daemon");
      log(`  daemon exit=${code}`);
    }
    await apiBootstrap.shutdown();
    rmSync(tmpWorkspaceRoot, { recursive: true, force: true });
    rmSync(beevibeDir, { recursive: true, force: true });
    if (backedUp) {
      execSync(`mv "${backupDir}" "${beevibeDir}"`, { stdio: "ignore" });
      log(`→ restored ~/.beevibe`);
    }
  }
}

main().catch((err) => {
  console.error("✗ M12C E2E failed:", err);
  process.exit(1);
});
