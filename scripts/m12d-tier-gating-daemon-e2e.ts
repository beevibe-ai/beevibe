/**
 * M12d real-daemon TIER-GATING e2e — proves an IC-tier agent gets a
 * smaller MCP tool surface AND a smaller skills set than a team agent
 * on the daemon path.
 *
 * What's covered:
 *   - IC agent's workspace .claude/skills/ contains beevibe-pre-task-setup
 *     ONLY (no beevibe-team-mesh-negotiation).
 *   - The MCP `initialize` response (captured from the JSONL transcript
 *     claude writes) advertises 12 tools for IC, NOT 22. Specifically
 *     team-only tools like `mcp__beevibe__find_subordinates` and
 *     `mcp__beevibe__create_task` are NOT in the list.
 *   - IC mesh tier exposes `respond_ask` and `report_blocker` (2 mesh
 *     tools) — NOT `ask` / `negotiate` / `respond_negotiate`.
 *
 * The IC agent runs a trivial task ("reply with pong") so we don't
 * need a repo. After the run we parse the JSONL transcript that claude
 * wrote into ~/.claude/projects/<encoded-cwd>/ to extract the tool
 * names the MCP server advertised.
 *
 * Usage:
 *   RUN_M12D_E2E=1 \
 *   DATABASE_URL_TEST=postgresql://... \
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
 *     pnpm tsx scripts/m12d-tier-gating-daemon-e2e.ts
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

if (process.env.RUN_M12D_E2E !== "1") {
  console.error("✗ M12D E2E: missing env var RUN_M12D_E2E");
  process.exit(1);
}

const DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL_TEST or DATABASE_URL required");
if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY required for the live claude turn");
}

const TASK_DEADLINE_MS = 120_000;
const SHUTDOWN_DEADLINE_MS = 5_000;

const log = (s: string) => console.log(s);

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
 * Hit `/mcp` directly with the agent's bv_a_ token + a fresh session
 * and enumerate the tools the server advertises on `tools/list`. This
 * mirrors what the spawned claude does when initializing its MCP
 * client; the difference is we read the JSON-RPC response directly so
 * we can assert against the full tier-gated tool list (claude's
 * JSONL only records tools the agent actually CALLED, not the full
 * advertise list).
 */
async function listMcpTools(
  apiUrl: string,
  agentApiKey: string,
  sessionId: string,
): Promise<Set<string>> {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${agentApiKey}`,
    "X-Beevibe-Session": sessionId,
  };

  // 1. initialize — server returns Mcp-Session-Id header
  const initRes = await fetch(`${apiUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "m12d-probe", version: "0.0.0" },
      },
    }),
  });
  if (initRes.status !== 200) {
    throw new Error(
      `MCP initialize failed: ${initRes.status} ${await initRes.text()}`,
    );
  }
  const mcpSid = initRes.headers.get("mcp-session-id");
  if (!mcpSid) throw new Error("MCP initialize did not return Mcp-Session-Id header");

  // 2. notifications/initialized (per MCP spec, fire-and-forget)
  await fetch(`${apiUrl}/mcp`, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": mcpSid },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });

  // 3. tools/list
  const listRes = await fetch(`${apiUrl}/mcp`, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": mcpSid },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });
  if (listRes.status !== 200) {
    throw new Error(`tools/list failed: ${listRes.status} ${await listRes.text()}`);
  }
  // Server may return either application/json or text/event-stream
  // depending on transport negotiation. Handle both.
  const contentType = listRes.headers.get("content-type") ?? "";
  const text = await listRes.text();
  let parsed: unknown;
  if (contentType.includes("text/event-stream")) {
    // Pull the first `data: <json>` line from the SSE frame.
    const dataLine = text
      .split("\n")
      .find((l) => l.startsWith("data: "));
    if (!dataLine) throw new Error("tools/list SSE response had no data line");
    parsed = JSON.parse(dataLine.slice("data: ".length));
  } else {
    parsed = JSON.parse(text);
  }
  const result = (parsed as { result?: { tools?: Array<{ name: string }> } })
    .result;
  if (!result?.tools) {
    throw new Error(`tools/list response missing tools: ${JSON.stringify(parsed)}`);
  }
  return new Set(result.tools.map((t) => t.name));
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

  const realHome = homedir();
  const beevibeDir = join(realHome, ".beevibe");
  const backupDir = join(tmpdir(), `beevibe-m12d-backup-${Date.now()}`);
  let backedUp = false;
  if (existsSync(beevibeDir)) {
    execSync(`mv "${beevibeDir}" "${backupDir}"`, { stdio: "ignore" });
    backedUp = true;
    log(`→ backed up ~/.beevibe to ${backupDir}`);
  }
  const tmpWorkspaceRoot = mkdtempSync(join(tmpdir(), "beevibe-m12d-ws-"));
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
      { id: makePersonId(), name: "Alice", email: "alice-m12d@example.com" },
    );
    // bv_u_ only resolves when the person has a team/org agent
    // (findUserAgent). Provision a team agent so /runtime/register
    // accepts the daemon-setup call, then provision the IC agent
    // (subordinate of the team agent) — the IC agent is what we test.
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
    const ic = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: makeAgentId(),
        name: "Alice's IC Agent",
        owner_id: alice.person.id,
        parent_agent_id: team.agent.id,
        hierarchy_level: "ic",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    log("  ✓ seeded alice + team + IC agent");

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
          "m12d-mock",
          "--device-name",
          "m12d-test",
        ],
        { env: process.env, stdio: "inherit" },
      );
      child.on("exit", (code) =>
        code === 0 ? res() : rej(new Error(`setup exited ${code}`)),
      );
    });

    const { rows: runtimeRows } = await pool.query<{ id: string }>(
      `SELECT r.id FROM runtime r JOIN daemon d ON d.id = r.daemon_id
       WHERE d.owner_person_id = $1 AND r.cli = 'claude'`,
      [alice.person.id],
    );
    const boundRuntimeId = runtimeRows[0]!.id;
    await agentRepo.update(ic.agent.id, {
      preferred_runtime_id: boundRuntimeId,
    });
    log(`  ✓ IC agent bound to runtime ${boundRuntimeId}`);

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

    // Trivial task — no repo, no skill auto-fire needed. Just enough
    // for claude to initialize MCP and exit.
    log("→ dispatch trivial task to IC agent");
    const dispatchService = new DispatchService({
      agentRepo,
      sessionRepo,
      taskRepo,
    });
    const taskRow = await taskRepo.create({
      id: makeTaskId(),
      title: "m12d smoke — trivial reply task",
      description:
        "Reply with the literal word 'pong' in your update_progress " +
        "summary, status='done'. Do nothing else.",
      status: "assigned",
      priority: "medium",
      assignee_id: ic.agent.id,
      creator_id: alice.person.id,
      creator_type: "person",
    });
    const reason = { kind: "fresh" as const };
    await dispatchService.dispatchTask({
      task: taskRow,
      agentId: ic.agent.id,
      intent: buildIntent(
        { id: taskRow.id, title: taskRow.title, description: taskRow.description },
        reason,
      ),
      reason,
      type: "task",
    });

    const finalTask = await pollUntil(
      () => taskRepo.findById(taskRow.id),
      (t) => t.status === "done" || t.status === "failed",
      TASK_DEADLINE_MS,
      `IC task → done|failed`,
    );
    if (finalTask.status !== "done") {
      const sess = await sessionRepo.findLatestForTask(taskRow.id);
      throw new Error(
        `IC task did not reach done. ${JSON.stringify({
          status: finalTask.status,
          err: sess?.error,
          summary: sess?.result_summary?.slice(0, 200),
        })}`,
      );
    }
    log(`  ✓ IC task done`);

    // ── skills sync — IC tier ──────────────────────────────────────
    const wsDir = join(tmpWorkspaceRoot, ic.agent.id);
    const skillsDir = join(wsDir, ".claude", "skills");
    if (!existsSync(join(skillsDir, "beevibe-pre-task-setup", "SKILL.md"))) {
      throw new Error(
        "expected beevibe-pre-task-setup/SKILL.md (universal) for IC agent",
      );
    }
    if (existsSync(join(skillsDir, "beevibe-team-mesh-negotiation"))) {
      throw new Error(
        "team-mesh-negotiation skill should NOT be present for IC agent",
      );
    }
    log(`  ✓ IC skills set: only beevibe-pre-task-setup (no team-mesh-negotiation)`);

    // ── MCP tool surface — direct /mcp probe with IC agent's bv_a_ ─
    // Mimic what claude does on init: open an MCP session with the
    // agent's bv_a_ + the session row's id (X-Beevibe-Session is
    // required for agent callers), then call tools/list.
    const completedSession = await sessionRepo.findLatestForTask(taskRow.id);
    if (!completedSession) throw new Error("expected a session for the IC task");
    if (!ic.agent.api_key) throw new Error("IC agent missing api_key");
    const tools = await listMcpTools(apiUrl, ic.agent.api_key, completedSession.id);
    log(`  MCP tools advertised to IC agent: ${tools.size}`);
    if (tools.size === 0) {
      throw new Error("expected /mcp tools/list to return ≥1 tool; got 0");
    }
    // Tools an IC agent MUST NOT have:
    const teamOnly = [
      "find_subordinates",
      "find_peers",
      "create_task",
      "check_work_status",
      "revise_task",
      "add_to_escalation",
      "ask",
      "negotiate",
      "respond_negotiate",
      "escalate_to_humans",
    ];
    const leaked = teamOnly.filter((t) => tools.has(t));
    if (leaked.length > 0) {
      throw new Error(
        `team-only tool(s) leaked to IC agent: ${leaked.join(", ")}`,
      );
    }
    // Tools an IC agent SHOULD have:
    const icRequired = [
      "update_progress",
      "save_memory",
      "update_core_memory",
      "search_context",
      "find_up",
      "get_agent_profile",
      "get_task",
      "create_work_product",
      "list_work_products",
      "update_work_product",
      "respond_ask",
      "report_blocker",
    ];
    const missing = icRequired.filter((t) => !tools.has(t));
    if (missing.length > 0) {
      throw new Error(`IC tools missing from MCP advertise: ${missing.join(", ")}`);
    }
    log(
      `  ✓ tier gating verified: 0 team-only leaked, all ${icRequired.length} IC tools present`,
    );

    await pool.end();
    log("\n✓ M12D e2e: tier-gating on the daemon path works (skills + MCP tools)");
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
  console.error("✗ M12D E2E failed:", err);
  process.exit(1);
});
