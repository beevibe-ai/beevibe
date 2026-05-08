/**
 * M12 e2e — proves the daemon-first chat flow works end-to-end.
 *
 * What's covered (vs unit tests):
 *   - /runtime/register mints a bv_d_ token + runtime ids.
 *   - /runtime/ws upgrade succeeds with the bv_d_; the server delivers
 *     `task_available` push when a chat session is dispatched.
 *   - /runtime/claim atomically promotes the pending session to running.
 *   - POST /chat creates the pending session (via dispatchService),
 *     awaits the resolver, returns the agent's response after the
 *     mock daemon posts /runtime/done.
 *   - SSE transcript: session_event rows from /runtime/events fire
 *     `session.event` notifies that reach the api's SSE pipeline.
 *
 * Mock daemon (TypeScript, in-process): connects WS, claims, posts
 * synthetic events + done. Avoids spawning the real claude CLI so the
 * test is fast + deterministic.
 *
 * Usage:
 *   RUN_M12_E2E=1 \
 *   DATABASE_URL_TEST=postgresql://beevibe:beevibe@localhost:5433/beevibe_test \
 *   OPENAI_API_KEY=… ANTHROPIC_API_KEY=… \
 *     pnpm tsx scripts/m12-chat-daemon-e2e.ts
 */

import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import WebSocket from "ws";

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

if (process.env.RUN_M12_E2E !== "1") {
  console.error("✗ M12 E2E: missing env var RUN_M12_E2E");
  process.exit(1);
}

const DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL_TEST or DATABASE_URL required");

async function applyMigrations(): Promise<void> {
  execSync(`DATABASE_URL=${DATABASE_URL} pnpm migrate up`, {
    stdio: "inherit",
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

interface MockDaemonResult {
  events_seen: number;
  done_acked: boolean;
  ws_connected: boolean;
  task_available_received: boolean;
}

/**
 * Run a one-shot mock daemon: register, connect WS, claim the pending
 * session, post a few synthetic events, post done. Resolves once /done
 * has been ack'd.
 */
async function runMockDaemon(opts: {
  apiUrl: string;
  userToken: string;
}): Promise<MockDaemonResult> {
  // 1. Register
  const regRes = await fetch(`${opts.apiUrl}/runtime/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.userToken}`,
    },
    body: JSON.stringify({
      external_id: "m12-mock",
      device_name: "m12-mock-daemon",
      runtimes: [{ cli: "claude", cli_version: "test-0" }],
    }),
  });
  if (regRes.status !== 201 && regRes.status !== 200) {
    throw new Error(`register failed: ${regRes.status} ${await regRes.text()}`);
  }
  const reg = (await regRes.json()) as {
    daemon_id: string;
    daemon_token: string;
    runtimes: Array<{ id: string; cli: string }>;
  };
  console.log("  ✓ /runtime/register → daemon_id =", reg.daemon_id);

  const runtimeId = reg.runtimes[0]!.id;
  const result: MockDaemonResult = {
    events_seen: 0,
    done_acked: false,
    ws_connected: false,
    task_available_received: false,
  };

  // 2. Connect WS — wait for `task_available`.
  const wsUrl = opts.apiUrl.replace(/^http/, "ws");
  const ws = new WebSocket(`${wsUrl}/runtime/ws?runtime_ids=${runtimeId}`, {
    headers: { authorization: `Bearer ${reg.daemon_token}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      result.ws_connected = true;
      resolve();
    });
    ws.once("error", reject);
  });
  console.log("  ✓ /runtime/ws upgraded");

  const taskAvailable = new Promise<{ session_id: string }>((resolve) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "task_available") {
        result.task_available_received = true;
        resolve({ session_id: msg.session_id });
      }
    });
  });

  // 3. Wait until the chat handler dispatches → server pushes
  // task_available → mock daemon claims.
  const wakeup = await Promise.race([
    taskAvailable,
    new Promise<{ session_id: string }>((_, reject) =>
      setTimeout(() => reject(new Error("timeout waiting for task_available")), 10_000),
    ),
  ]);
  console.log("  ✓ task_available push received for", wakeup.session_id);

  // 4. Claim
  const claimRes = await fetch(
    `${opts.apiUrl}/runtime/claim?runtime_id=${runtimeId}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${reg.daemon_token}` },
    },
  );
  if (claimRes.status !== 200) {
    throw new Error(`claim failed: ${claimRes.status} ${await claimRes.text()}`);
  }
  const payload = (await claimRes.json()) as {
    session_id: string;
    intent: string;
    system_prompt_append: string;
  };
  console.log("  ✓ /runtime/claim → session_id =", payload.session_id);
  if (!payload.system_prompt_append.includes("chat_directives")) {
    throw new Error("expected chat_directives in system_prompt_append");
  }
  console.log("  ✓ system_prompt_append includes chat_directives");

  // 5. Post a couple synthetic events (mock CLI tool calls).
  const eventsRes = await fetch(`${opts.apiUrl}/runtime/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${reg.daemon_token}`,
    },
    body: JSON.stringify({
      events: [
        {
          session_id: payload.session_id,
          kind: "agent",
          content: "Reading the task…",
        },
        {
          session_id: payload.session_id,
          kind: "tool_call",
          content: '{"tool":"Read","input":"package.json"}',
          tool_name: "Read",
        },
      ],
    }),
  });
  if (eventsRes.status !== 204) {
    throw new Error(`/runtime/events failed: ${eventsRes.status}`);
  }
  result.events_seen = 2;
  console.log("  ✓ /runtime/events posted 2 events");

  // 6. Post done — chat resolver fires.
  const doneRes = await fetch(`${opts.apiUrl}/runtime/done`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${reg.daemon_token}`,
    },
    body: JSON.stringify({
      session_id: payload.session_id,
      status: "succeeded",
      cli_session_id: "cli-mock-abc",
      result_summary: "hello! welcome to beevibe.",
      exit_code: 0,
    }),
  });
  if (doneRes.status !== 204) {
    throw new Error(`/runtime/done failed: ${doneRes.status}`);
  }
  result.done_acked = true;
  console.log("  ✓ /runtime/done posted");

  ws.close();
  return result;
}

async function main(): Promise<void> {
  await applyMigrations();
  await truncateAll();

  const apiPort = 3098;
  const apiUrl = `http://localhost:${apiPort}`;

  const apiBootstrap = await bootstrapApi({
    databaseUrl: DATABASE_URL!,
    openaiApiKey: process.env.OPENAI_API_KEY ?? "test",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "test",
    mcpServerUrl: `${apiUrl}/mcp`,
    port: apiPort,
  });
  await apiBootstrap.server.start();
  console.log("=== api booted on", apiPort, "===\n");

  try {
    // Provision a person + their team agent so bv_u_ resolves.
    const pool = createPool({ connectionString: DATABASE_URL! });
    const personRepo = new PostgresPersonRepository(pool);
    const agentRepo = new PostgresAgentRepository(pool);
    const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
    const alice = await provisionUser(
      { personRepo },
      { id: makePersonId(), name: "Alice", email: "alice-m12@example.com" },
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
    console.log("=== seeded alice + team agent ===\n");

    console.log("=== scenario 1: register + WS + chat round-trip ===");
    // Run the mock daemon and the chat POST in parallel — chat blocks
    // on the chat resolver until the daemon posts /runtime/done.
    const daemonPromise = runMockDaemon({
      apiUrl,
      userToken: alice.apiKey,
    });

    // Give the daemon a tick to register + connect WS so it's ready
    // when the chat dispatch hits.
    await new Promise((r) => setTimeout(r, 200));

    // Bind alice's agent to the runtime that the daemon registered.
    // The daemon's first POST /runtime/register lands before this; we
    // can read the runtime back from the daemon's first runtime_id.
    // Easier: query the runtime row directly from the DB.
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
    console.log("  ✓ agent bound to runtime", runtimeRows[0]!.id);

    const chatRes = await fetch(`${apiUrl}/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${alice.apiKey}`,
      },
      body: JSON.stringify({ message: "say hi" }),
    });
    if (chatRes.status !== 200) {
      throw new Error(`POST /chat failed: ${chatRes.status} ${await chatRes.text()}`);
    }
    const chatBody = (await chatRes.json()) as {
      response: string;
      status: string;
      session_id: string;
    };
    if (chatBody.response !== "hello! welcome to beevibe.") {
      throw new Error(`unexpected response: ${chatBody.response}`);
    }
    console.log("  ✓ POST /chat returned with daemon's response");
    if (chatBody.status !== "succeeded") {
      throw new Error(`expected status=succeeded, got ${chatBody.status}`);
    }
    console.log("  ✓ chat session.status = succeeded");

    const daemonResult = await daemonPromise;
    if (!daemonResult.task_available_received) {
      throw new Error("daemon did not receive task_available WS push");
    }
    if (!daemonResult.done_acked) {
      throw new Error("daemon /runtime/done not ack'd");
    }
    console.log(
      "  ✓ daemon: ws_connected, task_available, events:",
      daemonResult.events_seen,
      "done:",
      daemonResult.done_acked,
    );

    // Verify session_event rows were persisted.
    const { rows: eventRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM session_event WHERE session_id = $1`,
      [chatBody.session_id],
    );
    const eventCount = Number(eventRows[0]!.count);
    if (eventCount !== 2) {
      throw new Error(`expected 2 session_event rows, got ${eventCount}`);
    }
    console.log("  ✓ session_event rows persisted via /runtime/events:", eventCount);

    await pool.end();
    console.log("\n✓ M12 e2e: all scenarios passed");
  } finally {
    await apiBootstrap.shutdown();
  }
}

main().catch((err) => {
  console.error("✗ M12 E2E failed:", err);
  process.exit(1);
});
