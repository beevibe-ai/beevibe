/**
 * M12b real-daemon e2e — proves the daemon BINARY (not just the api
 * surface) drives an end-to-end chat turn against a live `claude` CLI.
 *
 * What's covered (vs m12 mock-daemon):
 *   - `beevibe-daemon setup` registers via real /runtime/register and
 *     persists ~/.beevibe/config.json.
 *   - `beevibe-daemon start` connects WS, polls, claims a real pending
 *     session, provisions a workspace via LocalWorkspaceManager
 *     (mcp-config.json + tier-filtered .claude/skills/), and spawns
 *     `claude` via ClaudeCodeRuntime.
 *   - Real stream-json parsing flows from claude → daemon → /runtime/events.
 *   - Real /runtime/done fires the chat resolver; POST /chat returns
 *     the actual LLM output.
 *
 * Cost: ~30–60s for one chat turn. Requires `claude` on PATH and a
 * real Anthropic key. Gated by `RUN_M12B_E2E=1` so CI doesn't fire it
 * by default.
 *
 * Usage:
 *   RUN_M12B_E2E=1 \
 *   DATABASE_URL_TEST=postgresql://... \
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
 *     pnpm tsx scripts/m12b-real-daemon-e2e.ts
 */

import { config as loadEnv } from "dotenv";
import { spawn, type ChildProcess, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
loadEnv({ path: resolve(repoRoot, ".env") });

import { agentId as makeAgentId, personId as makePersonId } from "../packages/core/src/domain/ids.js";
import { DEFAULT_RUNTIME_CONFIG } from "../packages/core/src/domain/agent.js";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresPersonRepository,
} from "../packages/core/src/adapters/postgres/index.js";
import { createPool } from "../packages/core/src/adapters/postgres/index.js";
import { provisionAgent, provisionUser } from "../packages/core/src/auth/provision.js";
import { bootstrap as bootstrapApi } from "../packages/api/src/bootstrap.js";

if (process.env.RUN_M12B_E2E !== "1") {
  console.error("✗ M12B E2E: missing env var RUN_M12B_E2E");
  process.exit(1);
}

const DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL_TEST or DATABASE_URL required");
if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY required for the live claude turn");
}

const TURN_DEADLINE_MS = 120_000;
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

  // The claude CLI's macOS keychain entry is bound to the user's real
  // HOME — overriding HOME breaks subscription auth. So we keep the
  // user's HOME and isolate two things:
  //   1. ~/.beevibe/config.json — daemon's own state. Backed up + restored.
  //   2. ~/.beevibe/workspaces — per-agent CLI workspaces. Routed to a
  //      tmpdir via WORKSPACE_ROOT (LocalWorkspaceManager honors it).
  const realHome = homedir();
  const beevibeDir = join(realHome, ".beevibe");
  const backupDir = join(tmpdir(), `beevibe-m12b-backup-${Date.now()}`);
  let backedUp = false;
  if (existsSync(beevibeDir)) {
    execSync(`mv "${beevibeDir}" "${backupDir}"`, { stdio: "ignore" });
    backedUp = true;
    log(`→ backed up ~/.beevibe to ${backupDir}`);
  } else {
    log(`→ no ~/.beevibe to back up`);
  }
  const tmpWorkspaceRoot = mkdtempSync(join(tmpdir(), "beevibe-m12b-ws-"));
  log(`→ workspace root → ${tmpWorkspaceRoot}`);

  let daemon: ChildProcess | undefined;
  try {
    // Provision alice + her team agent.
    const pool = createPool({ connectionString: DATABASE_URL! });
    const personRepo = new PostgresPersonRepository(pool);
    const agentRepo = new PostgresAgentRepository(pool);
    const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
    const alice = await provisionUser(
      { personRepo },
      { id: makePersonId(), name: "Alice", email: "alice-m12b@example.com" },
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

    log("→ daemon setup");
    const daemonMain = resolve(repoRoot, "packages/daemon/dist/main.js");
    await new Promise<void>((res, rej) => {
      const setup = spawn(
        process.execPath,
        [
          daemonMain,
          "setup",
          "--api",
          apiUrl,
          "--user-token",
          alice.apiKey,
          "--external-id",
          "m12b-mock",
          "--device-name",
          "m12b-test",
        ],
        { env: process.env, stdio: "inherit" },
      );
      setup.on("exit", (code) =>
        code === 0 ? res() : rej(new Error(`setup exited ${code}`)),
      );
    });
    log("  ✓ daemon setup complete");

    // Bind the agent to the freshly-registered runtime.
    const { rows: runtimeRows } = await pool.query<{ id: string }>(
      `SELECT r.id FROM runtime r JOIN daemon d ON d.id = r.daemon_id
       WHERE d.owner_person_id = $1 AND r.cli = 'claude'`,
      [alice.person.id],
    );
    if (runtimeRows.length === 0) {
      throw new Error("expected runtime row for alice's daemon");
    }
    await agentRepo.update(team.agent.id, {
      preferred_runtime_id: runtimeRows[0]!.id,
    });
    log(`  ✓ agent bound to runtime ${runtimeRows[0]!.id}`);

    // Start the long-running daemon.
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

    // Tiny grace so the daemon's WS connect lands before we POST /chat.
    await new Promise((r) => setTimeout(r, 1500));

    log("→ POST /chat (real claude turn — exercises an MCP tool)");
    // Ask claude to call save_memory(content="m12b sentinel: <random>",
    // fact_type="gotcha") and reply "pong". After the turn we assert
    // both: (a) it replied "pong" (proves daemon round-trip), (b) the
    // memory_fact table has a row with our sentinel content (proves
    // the spawned CLI's MCP client reached /mcp via the workspace's
    // mcp-config.json with the agent's bv_a_ token).
    const sentinel = `m12b-sentinel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const chatPromise = fetch(`${apiUrl}/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.apiKey}`,
      },
      body: JSON.stringify({
        message:
          `First, call mcp__beevibe__save_memory with content="${sentinel}" ` +
          `and fact_type="gotcha". Then reply with just the word "pong".`,
      }),
    });

    const timeout = new Promise<Response>((_, rej) =>
      setTimeout(() => rej(new Error("chat turn timeout")), TURN_DEADLINE_MS),
    );
    const chatRes = (await Promise.race([chatPromise, timeout])) as Response;
    const chatBody = (await chatRes.json()) as {
      ok: boolean;
      response: string;
      status: string;
      session_id: string;
    };
    log(
      `  ✓ /chat returned status=${chatRes.status} session_status=${chatBody.status}`,
    );
    if (chatRes.status !== 200) {
      throw new Error(`/chat returned ${chatRes.status}: ${JSON.stringify(chatBody)}`);
    }
    if (chatBody.status !== "succeeded") {
      const { rows } = await pool.query(
        `SELECT status, error, result_summary, exit_code FROM session WHERE id = $1`,
        [chatBody.session_id],
      );
      const row = rows[0] as
        | {
            status: string;
            error: string | null;
            result_summary: string | null;
            exit_code: number | null;
          }
        | undefined;
      throw new Error(
        `expected session.status=succeeded, got ${chatBody.status}; ` +
          `session row: ${JSON.stringify(row, null, 2)}`,
      );
    }
    if (!/pong/i.test(chatBody.response)) {
      throw new Error(
        `expected response to contain 'pong', got: ${chatBody.response}`,
      );
    }
    log(`  ✓ claude responded with: "${chatBody.response.trim()}"`);

    const { rows: eventRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM session_event WHERE session_id = $1`,
      [chatBody.session_id],
    );
    const eventCount = Number(eventRows[0]!.count);
    if (eventCount === 0) {
      throw new Error("expected ≥1 session_event row from real daemon");
    }
    log(`  ✓ session_event rows persisted from real daemon: ${eventCount}`);

    // ── MCP-tool reachability check ────────────────────────────────
    // The agent's CLI subprocess reads mcp-config.json from its
    // workspace and calls /mcp with the bv_a_ token. A successful
    // save_memory turns into a row in memory_fact. If the row is
    // missing, either the CLI never read mcp-config.json or the
    // token didn't authenticate correctly.
    const { rows: factRows } = await pool.query<{ content: string }>(
      `SELECT content FROM memory_fact WHERE agent_id = $1 AND content LIKE $2`,
      [team.agent.id, `%${sentinel}%`],
    );
    if (factRows.length === 0) {
      throw new Error(
        `expected memory_fact row containing sentinel "${sentinel}"; ` +
          `MCP tool save_memory did not land. Either the CLI didn't read ` +
          `mcp-config.json or the bv_a_ token didn't authenticate.`,
      );
    }
    log(`  ✓ MCP tool reached api: memory_fact row found ("${sentinel}")`);

    // ── Skills sync check ──────────────────────────────────────────
    // LocalWorkspaceManager.ensureWorkspace tier-syncs skills into
    // <workspace>/.claude/skills/. For a team-tier agent, both
    // beevibe-pre-task-setup (universal) and beevibe-team-mesh-negotiation
    // (team-only) should be present.
    const skillsDir = join(tmpWorkspaceRoot, team.agent.id, ".claude", "skills");
    if (!existsSync(skillsDir)) {
      throw new Error(`workspace skills dir missing: ${skillsDir}`);
    }
    for (const skillName of [
      "beevibe-pre-task-setup",
      "beevibe-team-mesh-negotiation",
    ]) {
      const skillFile = join(skillsDir, skillName, "SKILL.md");
      if (!existsSync(skillFile)) {
        throw new Error(
          `expected ${skillName}/SKILL.md in workspace; missing at ${skillFile}`,
        );
      }
    }
    log(
      `  ✓ skills present in workspace: beevibe-pre-task-setup, beevibe-team-mesh-negotiation`,
    );

    await pool.end();
    log("\n✓ M12B e2e: real-daemon round-trip passed");
  } finally {
    if (daemon) {
      log("→ shutdown daemon");
      const code = await shutdown(daemon, "daemon");
      log(`  daemon exit=${code}`);
    }
    await apiBootstrap.shutdown();
    rmSync(tmpWorkspaceRoot, { recursive: true, force: true });
    // Remove ~/.beevibe written by this test, then restore the user's
    // pre-existing state (if any).
    rmSync(beevibeDir, { recursive: true, force: true });
    if (backedUp) {
      execSync(`mv "${backupDir}" "${beevibeDir}"`, { stdio: "ignore" });
      log(`→ restored ~/.beevibe`);
    }
  }
}

main().catch((err) => {
  console.error("✗ M12B E2E failed:", err);
  process.exit(1);
});
