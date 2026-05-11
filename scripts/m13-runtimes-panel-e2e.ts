/**
 * M13 e2e — proves the Phase 5 Runtimes panel surface end-to-end.
 *
 * What's covered (vs unit tests):
 *   - GET /runtimes against a real api boot returns the same shape the
 *     web UI consumes (daemons + nested runtimes + online flag).
 *   - The `online` flag tracks live DaemonHub state — flips false → true
 *     when a daemon connects via /runtime/ws, false again when it
 *     disconnects.
 *   - POST /runtimes/:id/revoke marks `revoked_at` and is idempotent.
 *   - After revoke: GET /runtimes excludes the daemon, and the daemon's
 *     bv_d_ token loses authentication on /runtime/heartbeat (lookup
 *     filters revoked_at IS NULL, which mirrors the WS reject path on
 *     the next reconnect attempt).
 *   - Tenant isolation: Alice never sees Bob's daemons in her panel.
 *
 * Usage:
 *   RUN_M13_E2E=1 \
 *   DATABASE_URL_TEST=postgresql://beevibe:beevibe@localhost:5433/beevibe_test \
 *   OPENAI_API_KEY=… ANTHROPIC_API_KEY=… \
 *     pnpm tsx scripts/m13-runtimes-panel-e2e.ts
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

if (process.env.RUN_M13_E2E !== "1") {
  console.error("✗ M13 E2E: missing env var RUN_M13_E2E");
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

interface RegisterResult {
  daemon_id: string;
  daemon_token: string;
  runtimes: Array<{ id: string; cli: string }>;
}

async function register(opts: {
  apiUrl: string;
  userToken: string;
  externalId: string;
  deviceName: string;
  clis?: Array<{ cli: string; cli_version?: string }>;
}): Promise<RegisterResult> {
  const res = await fetch(`${opts.apiUrl}/runtime/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.userToken}`,
    },
    body: JSON.stringify({
      external_id: opts.externalId,
      device_name: opts.deviceName,
      runtimes: opts.clis ?? [{ cli: "claude", cli_version: "test-0" }],
    }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`/runtime/register failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as RegisterResult;
}

interface ListResp {
  ok: true;
  daemons: Array<{
    id: string;
    device_name: string;
    external_id: string;
    last_seen_at: string | null;
    runtimes: Array<{
      id: string;
      cli: string;
      cli_version: string | null;
      online: boolean;
    }>;
  }>;
}

async function listRuntimes(opts: {
  apiUrl: string;
  userToken: string;
}): Promise<ListResp> {
  const res = await fetch(`${opts.apiUrl}/runtimes`, {
    headers: { authorization: `Bearer ${opts.userToken}` },
  });
  if (res.status !== 200) {
    throw new Error(`GET /runtimes failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ListResp;
}

async function revoke(opts: {
  apiUrl: string;
  userToken: string;
  daemonId: string;
}): Promise<{ ok: true; daemon_id: string; already_revoked: boolean }> {
  const res = await fetch(
    `${opts.apiUrl}/runtimes/${encodeURIComponent(opts.daemonId)}/revoke`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.userToken}`,
      },
      body: JSON.stringify({}),
    },
  );
  if (res.status !== 200) {
    throw new Error(
      `POST /runtimes/${opts.daemonId}/revoke failed: ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as { ok: true; daemon_id: string; already_revoked: boolean };
}

async function openWs(opts: {
  apiUrl: string;
  daemonToken: string;
  runtimeId: string;
}): Promise<WebSocket> {
  const wsUrl = opts.apiUrl.replace(/^http/, "ws");
  const ws = new WebSocket(`${wsUrl}/runtime/ws?runtime_ids=${opts.runtimeId}`, {
    headers: { authorization: `Bearer ${opts.daemonToken}` },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

async function closeWs(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

async function main(): Promise<void> {
  await applyMigrations();
  await truncateAll();

  const apiPort = 3099;
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
    const pool = createPool({ connectionString: DATABASE_URL! });
    const personRepo = new PostgresPersonRepository(pool);
    const agentRepo = new PostgresAgentRepository(pool);
    const coreMemoryRepo = new PostgresCoreMemoryRepository(pool);

    // Provision Alice + her team agent (so bv_u_ resolves).
    const alice = await provisionUser(
      { personRepo },
      { id: makePersonId(), name: "Alice", email: "alice-m13@example.com" },
    );
    await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: makeAgentId(),
        name: "Alice's Team",
        owner_id: alice.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    console.log("=== seeded alice ===\n");

    /* ─── scenario 1 ─────────────────────────────────────────────── */
    console.log("=== scenario 1: empty panel for fresh user ===");
    {
      const list = await listRuntimes({ apiUrl, userToken: alice.apiKey });
      if (list.daemons.length !== 0) {
        throw new Error(`expected empty daemons; got ${list.daemons.length}`);
      }
      console.log("  ✓ GET /runtimes → []\n");
    }

    /* ─── scenario 2 ─────────────────────────────────────────────── */
    console.log("=== scenario 2: register + offline, then WS → online ===");
    const reg = await register({
      apiUrl,
      userToken: alice.apiKey,
      externalId: "alice-mac",
      deviceName: "Alice's MacBook",
      clis: [
        { cli: "claude", cli_version: "1.2.3" },
        { cli: "codex", cli_version: "0.4.1" },
      ],
    });
    console.log("  ✓ /runtime/register → daemon_id =", reg.daemon_id);

    {
      const list = await listRuntimes({ apiUrl, userToken: alice.apiKey });
      if (list.daemons.length !== 1) {
        throw new Error(`expected 1 daemon; got ${list.daemons.length}`);
      }
      const d = list.daemons[0]!;
      if (d.id !== reg.daemon_id) throw new Error("daemon id mismatch");
      if (d.device_name !== "Alice's MacBook") throw new Error("device_name wrong");
      if (d.runtimes.length !== 2) {
        throw new Error(`expected 2 runtimes; got ${d.runtimes.length}`);
      }
      for (const r of d.runtimes) {
        if (r.online !== false) throw new Error(`expected offline; got online for ${r.cli}`);
      }
      console.log("  ✓ GET /runtimes → 1 daemon, 2 runtimes, all offline");
    }

    const claudeRuntimeId = reg.runtimes.find((r) => r.cli === "claude")!.id;
    const ws = await openWs({
      apiUrl,
      daemonToken: reg.daemon_token,
      runtimeId: claudeRuntimeId,
    });
    console.log("  ✓ /runtime/ws upgraded for claude runtime");

    // Hub.register is synchronous on connection; one tick is enough.
    await new Promise((r) => setTimeout(r, 50));

    {
      const list = await listRuntimes({ apiUrl, userToken: alice.apiKey });
      const d = list.daemons[0]!;
      const claude = d.runtimes.find((r) => r.cli === "claude")!;
      const codex = d.runtimes.find((r) => r.cli === "codex")!;
      if (!claude.online) throw new Error("claude runtime should be online after WS");
      if (codex.online) throw new Error("codex runtime not subscribed; should be offline");
      console.log("  ✓ GET /runtimes → claude online, codex still offline\n");
    }

    /* ─── scenario 3 ─────────────────────────────────────────────── */
    console.log("=== scenario 3: WS disconnect → online flips back ===");
    await closeWs(ws);
    // Hub.unregister fires on the WS 'close' event handler. Settle.
    await new Promise((r) => setTimeout(r, 100));
    {
      const list = await listRuntimes({ apiUrl, userToken: alice.apiKey });
      const claude = list.daemons[0]!.runtimes.find((r) => r.cli === "claude")!;
      if (claude.online) throw new Error("claude runtime should be offline after WS close");
      console.log("  ✓ claude runtime back to offline\n");
    }

    /* ─── scenario 4 ─────────────────────────────────────────────── */
    console.log("=== scenario 4: revoke + idempotency + auth dies ===");
    {
      const r1 = await revoke({
        apiUrl,
        userToken: alice.apiKey,
        daemonId: reg.daemon_id,
      });
      if (r1.already_revoked) throw new Error("first revoke should be already_revoked=false");
      console.log("  ✓ POST /runtimes/:id/revoke → first call succeeds");

      const r2 = await revoke({
        apiUrl,
        userToken: alice.apiKey,
        daemonId: reg.daemon_id,
      });
      if (!r2.already_revoked) throw new Error("second revoke should be already_revoked=true");
      console.log("  ✓ second revoke is idempotent (already_revoked=true)");
    }

    {
      const list = await listRuntimes({ apiUrl, userToken: alice.apiKey });
      if (list.daemons.length !== 0) {
        throw new Error("revoked daemon should be excluded from list");
      }
      console.log("  ✓ GET /runtimes excludes revoked daemons");
    }

    {
      // The bv_d_ token was minted earlier; lookup filters revoked. The
      // heartbeat handler maps that to 401 invalid_token.
      const heartbeat = await fetch(`${apiUrl}/runtime/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${reg.daemon_token}`,
        },
        body: JSON.stringify({ runtime_ids: [claudeRuntimeId] }),
      });
      if (heartbeat.status !== 401) {
        throw new Error(
          `expected 401 on heartbeat with revoked token; got ${heartbeat.status}`,
        );
      }
      console.log("  ✓ /runtime/heartbeat with revoked token → 401\n");
    }

    /* ─── scenario 5 ─────────────────────────────────────────────── */
    console.log("=== scenario 5: tenant isolation ===");
    const bob = await provisionUser(
      { personRepo },
      { id: makePersonId(), name: "Bob", email: "bob-m13@example.com" },
    );
    await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: makeAgentId(),
        name: "Bob's Team",
        owner_id: bob.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    const bobReg = await register({
      apiUrl,
      userToken: bob.apiKey,
      externalId: "bob-mac",
      deviceName: "Bob's MacBook",
    });

    {
      const aliceList = await listRuntimes({ apiUrl, userToken: alice.apiKey });
      if (aliceList.daemons.length !== 0) {
        throw new Error("alice should still see 0 daemons (her one is revoked)");
      }
      const bobList = await listRuntimes({ apiUrl, userToken: bob.apiKey });
      if (bobList.daemons.length !== 1) {
        throw new Error(`bob should see 1 daemon; got ${bobList.daemons.length}`);
      }
      if (bobList.daemons[0]!.id !== bobReg.daemon_id) {
        throw new Error("bob's panel should show his own daemon");
      }
      console.log("  ✓ alice sees 0; bob sees 1 (his own)");

      // Cross-tenant revoke attempt — Alice tries to revoke Bob's daemon.
      const xss = await fetch(
        `${apiUrl}/runtimes/${encodeURIComponent(bobReg.daemon_id)}/revoke`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${alice.apiKey}`,
          },
          body: JSON.stringify({}),
        },
      );
      if (xss.status !== 404) {
        throw new Error(
          `cross-tenant revoke should return 404 (no existence leak); got ${xss.status}`,
        );
      }
      console.log("  ✓ alice → revoke bob's daemon → 404 (no existence leak)");

      // Bob's daemon is still alive after the failed cross-tenant attempt.
      const bobAfter = await listRuntimes({ apiUrl, userToken: bob.apiKey });
      if (bobAfter.daemons.length !== 1) {
        throw new Error("bob's daemon should be untouched");
      }
      console.log("  ✓ bob's daemon untouched\n");
    }

    await pool.end();
    console.log("✓ M13 e2e: all scenarios passed");
  } finally {
    await apiBootstrap.shutdown();
  }
}

main().catch((err) => {
  console.error("✗ M13 E2E failed:", err);
  process.exit(1);
});
