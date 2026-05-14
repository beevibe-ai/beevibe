/**
 * /runtime/ws — bearer auth on upgrade + hub registration. Tests boot a
 * real http.Server, attach the WS server, and connect with the `ws`
 * client to exercise the upgrade path end-to-end.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  PostgresAgentRepository,
  PostgresDaemonRepository,
  PostgresPersonRepository,
  PostgresRuntimeRepository,
  type Pool,
} from "@beevibe/core/adapters/postgres";
import {
  generateDaemonApiKey,
  hashDaemonToken,
  provisionUser,
} from "@beevibe/core/auth";
import { daemonId, personId, runtimeId } from "@beevibe/core";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import { DaemonHub } from "./hub.js";
import { RuntimeWsServer } from "./ws-server.js";

interface Fixture {
  ownerId: string;
  daemonId: string;
  daemonToken: string;
  runtimeId: string;
}

describe("RuntimeWsServer", () => {
  let pool: Pool;
  let agentRepo: PostgresAgentRepository;
  let personRepo: PostgresPersonRepository;
  let daemonRepo: PostgresDaemonRepository;
  let runtimeRepo: PostgresRuntimeRepository;
  let httpServer: Server;
  let wsServer: RuntimeWsServer;
  let hub: DaemonHub;
  let port: number;

  beforeAll(async () => {
    pool = createTestPool();
    agentRepo = new PostgresAgentRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
    daemonRepo = new PostgresDaemonRepository(pool);
    runtimeRepo = new PostgresRuntimeRepository(pool);

    httpServer = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    hub = new DaemonHub();
    wsServer = new RuntimeWsServer({
      hub,
      authDeps: { agentRepo, personRepo, daemonRepo },
      runtimeRepo,
      pingIntervalMs: 60_000,
    });
    wsServer.attach(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => resolve());
    });
    const addr = httpServer.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterAll(async () => {
    await wsServer.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  async function setupFixture(): Promise<Fixture> {
    const owner = await provisionUser(
      { personRepo },
      { id: personId(), name: "Owner", email: "owner@example.com" },
    );
    const token = generateDaemonApiKey();
    const dId = daemonId();
    await daemonRepo.create({
      id: dId,
      owner_person_id: owner.person.id,
      external_id: "macbook-pro",
      device_name: "MacBook Pro",
      token_hash: hashDaemonToken(token),
    });
    const rId = runtimeId();
    await runtimeRepo.create({ id: rId, daemon_id: dId, cli: "claude" });
    return { ownerId: owner.person.id, daemonId: dId, daemonToken: token, runtimeId: rId };
  }

  function connect(
    path: string,
    headers: Record<string, string>,
  ): Promise<{ ws?: WebSocket; statusCode?: number }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}${path}`, { headers });
      ws.once("open", () => resolve({ ws }));
      ws.once("unexpected-response", (_req, res) => {
        resolve({ statusCode: res.statusCode });
      });
      ws.once("error", () => resolve({ statusCode: 0 }));
    });
  }

  it("upgrades a valid daemon caller and registers it on the hub", async () => {
    const fx = await setupFixture();
    expect((await runtimeRepo.findById(fx.runtimeId))?.last_heartbeat).toBeUndefined();

    const { ws } = await connect(`/runtime/ws?runtime_ids=${fx.runtimeId}`, {
      Authorization: `Bearer ${fx.daemonToken}`,
    });
    expect(ws).toBeDefined();
    expect(hub.size()).toBe(1);
    expect(hub.hasRuntime(fx.runtimeId)).toBe(true);

    // Connect-time heartbeat is fire-and-forget, so poll until the row
    // reflects it. Bump on WS connect feeds the DB trigger that fires
    // `runtime.updated` SSE — without it the web waits for the next HTTP
    // heartbeat (~30s) to flip the online dot.
    const heartbeatAt = await waitFor(
      async () => (await runtimeRepo.findById(fx.runtimeId))?.last_heartbeat,
    );
    expect(heartbeatAt).toBeInstanceOf(Date);

    // Notify reaches the live socket.
    const received = new Promise<string>((resolve) => ws!.once("message", (data) => {
      resolve(data.toString());
    }));
    hub.notify(fx.runtimeId, "sess_42");
    const msg = JSON.parse(await received);
    expect(msg).toEqual({
      type: "task_available",
      runtime_id: fx.runtimeId,
      session_id: "sess_42",
    });

    ws!.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(hub.size()).toBe(0);
  });

  it("rejects upgrade when Authorization header is missing", async () => {
    const fx = await setupFixture();
    const { statusCode } = await connect(
      `/runtime/ws?runtime_ids=${fx.runtimeId}`,
      {},
    );
    expect(statusCode).toBe(401);
  });

  it("rejects upgrade when token is bv_u_ instead of bv_d_", async () => {
    const owner = await provisionUser(
      { personRepo },
      { id: personId(), name: "Owner", email: "human@example.com" },
    );
    const fx = await setupFixture();
    const { statusCode } = await connect(
      `/runtime/ws?runtime_ids=${fx.runtimeId}`,
      { Authorization: `Bearer ${owner.apiKey}` },
    );
    expect(statusCode).toBe(401);
  });

  it("rejects upgrade when runtime_ids missing", async () => {
    const fx = await setupFixture();
    const { statusCode } = await connect("/runtime/ws", {
      Authorization: `Bearer ${fx.daemonToken}`,
    });
    expect(statusCode).toBe(400);
  });

  it("rejects upgrade when caller does not own the requested runtime", async () => {
    const a = await setupFixture();
    // Different daemon owner.
    const otherOwner = await provisionUser(
      { personRepo },
      { id: personId(), name: "Other", email: "other@example.com" },
    );
    const otherToken = generateDaemonApiKey();
    const otherDId = daemonId();
    await daemonRepo.create({
      id: otherDId,
      owner_person_id: otherOwner.person.id,
      external_id: "other-mac",
      device_name: "Other Mac",
      token_hash: hashDaemonToken(otherToken),
    });

    const { statusCode } = await connect(
      `/runtime/ws?runtime_ids=${a.runtimeId}`,
      { Authorization: `Bearer ${otherToken}` },
    );
    expect(statusCode).toBe(403);
  });

});

async function waitFor<T>(
  check: () => Promise<T | undefined>,
  { timeoutMs = 500, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await check();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}
