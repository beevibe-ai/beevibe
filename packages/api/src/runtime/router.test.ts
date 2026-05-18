/**
 * /runtime/* HTTP surface, integration-tested against a real Postgres so
 * the claim FOR UPDATE SKIP LOCKED path is exercised end-to-end.
 *
 * MemoryAgent is mocked with a stub `prepareBriefing` that returns empty
 * strings — composing real briefings would require pgvector + OpenAI and
 * isn't what this surface is testing.
 */

import express, { json } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PostgresAgentRepository,
  PostgresCoreMemoryRepository,
  PostgresDaemonRepository,
  PostgresPersonRepository,
  PostgresRuntimeRepository,
  PostgresSessionEventRepository,
  PostgresSessionRepository,
  type Pool,
} from "@beevibe/core/adapters/postgres";
import {
  generateDaemonApiKey,
  hashDaemonToken,
  provisionAgent,
  provisionUser,
} from "@beevibe/core/auth";
import {
  DEFAULT_RUNTIME_CONFIG,
  agentId,
  daemonId,
  runtimeId,
  sessionId as makeSessionId,
  personId,
} from "@beevibe/core";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import { createTestPool, truncateAll } from "@beevibe/core/test-helpers";
import { createAuthMiddleware } from "../auth/middleware.js";
import { DaemonHub } from "./hub.js";
import { createRuntimeRouter, type RuntimeRouterDeps } from "./router.js";

function makeMemoryAgentStub(): MemoryAgent {
  return {
    prepareBriefing: vi.fn().mockResolvedValue({
      systemPromptAppend: "<core>stub</core>",
      userMessagePrefix: "<archival>stub</archival>",
      snapshot: {
        block_count: 0,
        fact_count: 0,
        token_count: 0,
        blocks: [],
        facts: [],
      },
    }),
    onTaskComplete: vi.fn(),
  } as unknown as MemoryAgent;
}

describe("/runtime — integration", () => {
  let pool: Pool;
  let agentRepo: PostgresAgentRepository;
  let personRepo: PostgresPersonRepository;
  let daemonRepo: PostgresDaemonRepository;
  let runtimeRepo: PostgresRuntimeRepository;
  let sessionRepo: PostgresSessionRepository;
  let sessionEventRepo: PostgresSessionEventRepository;
  let coreMemoryRepo: PostgresCoreMemoryRepository;
  let hub: DaemonHub;
  let onSessionComplete: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    pool = createTestPool();
    agentRepo = new PostgresAgentRepository(pool);
    personRepo = new PostgresPersonRepository(pool);
    daemonRepo = new PostgresDaemonRepository(pool);
    runtimeRepo = new PostgresRuntimeRepository(pool);
    sessionRepo = new PostgresSessionRepository(pool);
    sessionEventRepo = new PostgresSessionEventRepository(pool);
    coreMemoryRepo = new PostgresCoreMemoryRepository(pool);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    hub = new DaemonHub();
    onSessionComplete = vi.fn().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await pool.end();
  });

  function makeApp(deps?: Partial<RuntimeRouterDeps>) {
    const baseDeps: RuntimeRouterDeps = {
      authMiddleware: createAuthMiddleware({ agentRepo, personRepo, daemonRepo }),
      agentRepo,
      personRepo,
      daemonRepo,
      runtimeRepo,
      sessionRepo,
      sessionEventRepo,
      hub,
      makeMemoryAgent: () => makeMemoryAgentStub(),
      mcpServerUrl: "http://api.test/mcp",
      skillsSourceDir: "/tmp/m12-skills-stub",
      onSessionComplete,
      ...deps,
    };
    const app = express();
    app.use(json());
    app.use("/runtime", createRuntimeRouter(baseDeps));
    return app;
  }

  async function makePersonWithAgent(name: string, email: string) {
    const person = await provisionUser(
      { personRepo },
      { id: personId(), name, email },
    );
    const agent = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: `${name}'s Agent`,
        owner_id: person.person.id,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
    return { person, agent };
  }

  async function makeAlice() {
    const { person } = await makePersonWithAgent("Alice", "alice@example.com");
    return person;
  }

  async function makeAgent(ownerId: string) {
    return provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: agentId(),
        name: "Alice's Other Agent",
        owner_id: ownerId,
        hierarchy_level: "team",
        runtime_config: DEFAULT_RUNTIME_CONFIG,
      },
    );
  }

  async function makeRegisteredDaemon(ownerPersonId: string) {
    const token = generateDaemonApiKey();
    const dId = daemonId();
    await daemonRepo.create({
      id: dId,
      owner_person_id: ownerPersonId,
      external_id: "macbook-pro",
      device_name: "MacBook Pro",
      token_hash: hashDaemonToken(token),
    });
    const rId = runtimeId();
    await runtimeRepo.create({ id: rId, daemon_id: dId, cli: "claude" });
    return { token, daemonId: dId, runtimeId: rId };
  }

  /* ─── /runtime/register ───────────────────────────────────────────── */

  describe("POST /runtime/register", () => {
    it("creates a daemon + runtimes for a fresh external_id (201)", async () => {
      const alice = await makeAlice();
      const res = await request(makeApp())
        .post("/runtime/register")
        .set("Authorization", `Bearer ${alice.apiKey}`)
        .send({
          external_id: "macbook-pro",
          device_name: "MacBook Pro",
          runtimes: [{ cli: "claude", cli_version: "1.2.3" }],
        });

      expect(res.status).toBe(201);
      expect(res.body.daemon_id).toMatch(/^dmn_/);
      expect(res.body.daemon_token).toMatch(/^bv_d_/);
      expect(res.body.runtimes).toHaveLength(1);
      expect(res.body.runtimes[0]).toMatchObject({ cli: "claude" });

      const created = await daemonRepo.findById(res.body.daemon_id);
      expect(created?.device_name).toBe("MacBook Pro");
      expect(created?.token_hash).toBe(hashDaemonToken(res.body.daemon_token));
    });

    it("upserts on (owner, external_id) collision and rotates the token (200)", async () => {
      const alice = await makeAlice();
      const first = await request(makeApp())
        .post("/runtime/register")
        .set("Authorization", `Bearer ${alice.apiKey}`)
        .send({
          external_id: "macbook-pro",
          device_name: "MacBook Pro",
          runtimes: [{ cli: "claude" }],
        });
      const firstToken = first.body.daemon_token;

      const second = await request(makeApp())
        .post("/runtime/register")
        .set("Authorization", `Bearer ${alice.apiKey}`)
        .send({
          external_id: "macbook-pro",
          device_name: "MacBook Pro (renamed)",
          runtimes: [{ cli: "claude" }, { cli: "codex" }],
        });

      expect(second.status).toBe(200);
      expect(second.body.daemon_id).toBe(first.body.daemon_id);
      expect(second.body.daemon_token).not.toBe(firstToken);
      expect(second.body.runtimes.map((r: { cli: string }) => r.cli).sort()).toEqual([
        "claude",
        "codex",
      ]);
    });

    it("rejects daemon callers (only bv_u_ may register)", async () => {
      const alice = await makeAlice();
      const { token } = await makeRegisteredDaemon(alice.person.id);
      const res = await request(makeApp())
        .post("/runtime/register")
        .set("Authorization", `Bearer ${token}`)
        .send({
          external_id: "x",
          device_name: "x",
          runtimes: [{ cli: "claude" }],
        });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("human_required");
    });

    it("returns 400 when body is malformed", async () => {
      const alice = await makeAlice();
      const res = await request(makeApp())
        .post("/runtime/register")
        .set("Authorization", `Bearer ${alice.apiKey}`)
        .send({ external_id: "x" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
    });
  });

  /* ─── /runtime/sync ───────────────────────────────────────────────── */

  describe("POST /runtime/sync", () => {
    it("adds a newly-detected CLI to an existing daemon without rotating the token", async () => {
      const alice = await makeAlice();
      const { token, daemonId: dId, runtimeId: rId } = await makeRegisteredDaemon(
        alice.person.id,
      );

      const res = await request(makeApp())
        .post("/runtime/sync")
        .set("Authorization", `Bearer ${token}`)
        .send({
          runtimes: [
            { cli: "claude", cli_version: "1.2.3" },
            { cli: "codex", cli_version: "0.47.0" },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.runtimes.map((r: { cli: string }) => r.cli).sort()).toEqual([
        "claude",
        "codex",
      ]);
      const claudeRow = res.body.runtimes.find(
        (r: { cli: string }) => r.cli === "claude",
      );
      expect(claudeRow?.id).toBe(rId);
      const codexRow = res.body.runtimes.find(
        (r: { cli: string }) => r.cli === "codex",
      );
      expect(codexRow?.id).toMatch(/^rt_/);

      // Token must NOT rotate — that's the whole point of /sync vs /register.
      const daemon = await daemonRepo.findById(dId);
      expect(daemon?.token_hash).toBe(hashDaemonToken(token));
    });

    it("updates cli_version when a re-detected CLI reports a new version", async () => {
      const alice = await makeAlice();
      const { token, runtimeId: rId } = await makeRegisteredDaemon(alice.person.id);

      const res = await request(makeApp())
        .post("/runtime/sync")
        .set("Authorization", `Bearer ${token}`)
        .send({ runtimes: [{ cli: "claude", cli_version: "2.0.0" }] });

      expect(res.status).toBe(200);
      const updated = await runtimeRepo.findById(rId);
      expect(updated?.cli_version).toBe("2.0.0");
    });

    it("rejects human callers (only bv_d_ may sync)", async () => {
      const alice = await makeAlice();
      const res = await request(makeApp())
        .post("/runtime/sync")
        .set("Authorization", `Bearer ${alice.apiKey}`)
        .send({ runtimes: [{ cli: "claude" }] });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("daemon_required");
    });

    it("returns 400 when body is malformed", async () => {
      const alice = await makeAlice();
      const { token } = await makeRegisteredDaemon(alice.person.id);
      const res = await request(makeApp())
        .post("/runtime/sync")
        .set("Authorization", `Bearer ${token}`)
        .send({ runtimes: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
    });

    it("scopes upsert to the caller's daemon — cannot mutate another daemon's runtimes", async () => {
      const alice = await makeAlice();
      const { person: bob } = await makePersonWithAgent("Bob", "bob-sync@example.com");
      const aliceDaemon = await makeRegisteredDaemon(alice.person.id);
      const bobDaemon = await makeRegisteredDaemon(bob.person.id);

      await request(makeApp())
        .post("/runtime/sync")
        .set("Authorization", `Bearer ${aliceDaemon.token}`)
        .send({ runtimes: [{ cli: "codex" }] });

      const bobRuntime = await runtimeRepo.findById(bobDaemon.runtimeId);
      expect(bobRuntime?.cli).toBe("claude");
      const bobCodex = await runtimeRepo.findByDaemonAndCli(bobDaemon.daemonId, "codex");
      expect(bobCodex).toBeUndefined();
    });
  });

  /* ─── /runtime/heartbeat ──────────────────────────────────────────── */

  describe("POST /runtime/heartbeat", () => {
    it("touches last_heartbeat for each runtime and last_seen_at on the daemon", async () => {
      const alice = await makeAlice();
      const { token, daemonId: dId, runtimeId: rId } = await makeRegisteredDaemon(
        alice.person.id,
      );
      expect((await runtimeRepo.findById(rId))?.last_heartbeat).toBeUndefined();
      expect((await daemonRepo.findById(dId))?.last_seen_at).toBeUndefined();

      const res = await request(makeApp())
        .post("/runtime/heartbeat")
        .set("Authorization", `Bearer ${token}`)
        .send({ runtime_ids: [rId] });

      expect(res.status).toBe(204);
      expect((await runtimeRepo.findById(rId))?.last_heartbeat).toBeInstanceOf(Date);
      expect((await daemonRepo.findById(dId))?.last_seen_at).toBeInstanceOf(Date);
    });

    it("rejects non-daemon callers", async () => {
      const alice = await makeAlice();
      const res = await request(makeApp())
        .post("/runtime/heartbeat")
        .set("Authorization", `Bearer ${alice.apiKey}`)
        .send({ runtime_ids: [] });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("daemon_required");
    });
  });

  /* ─── /runtime/claim ──────────────────────────────────────────────── */

  describe("POST /runtime/claim", () => {
    it("returns 204 when no pending session exists", async () => {
      const alice = await makeAlice();
      const { token, runtimeId: rId } = await makeRegisteredDaemon(alice.person.id);
      const res = await request(makeApp())
        .post(`/runtime/claim?runtime_id=${rId}`)
        .set("Authorization", `Bearer ${token}`)
        .send();
      expect(res.status).toBe(204);
    });

    it("claims the pending session, promotes to running, returns dispatch payload", async () => {
      const alice = await makeAlice();
      const a = await makeAgent(alice.person.id);
      const { token, runtimeId: rId } = await makeRegisteredDaemon(alice.person.id);
      const sid = makeSessionId();
      await sessionRepo.create({
        id: sid,
        agent_id: a.agent.id,
        type: "chat",
        status: "pending",
        intent: "hello",
        runtime_id: rId,
      });

      const res = await request(makeApp())
        .post(`/runtime/claim?runtime_id=${rId}`)
        .set("Authorization", `Bearer ${token}`)
        .send();

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        session_id: sid,
        agent_id: a.agent.id,
        agent_api_key: a.agent.api_key,
        agent_hierarchy_level: "team",
        runtime_type: "claude",
        type: "chat",
        mcp_server_url: "http://api.test/mcp",
        env: { BEEVIBE_SESSION_ID: sid, BEEVIBE_AGENT_ID: a.agent.id },
      });
      expect(res.body.intent).toContain("hello");
      expect(res.body.intent).toContain("<archival>stub</archival>");
      expect(res.body.system_prompt_append).toContain("<core>stub</core>");
      expect(res.body.system_prompt_append).toContain("beevibe_lifecycle");

      const updated = await sessionRepo.findById(sid);
      expect(updated?.status).toBe("running");
      expect(updated?.started_at).toBeInstanceOf(Date);
      expect(updated?.briefing).toBeDefined();
    });

    it("rejects when daemon does not own the runtime (cross-tenant)", async () => {
      const alice = await makeAlice();
      const { person: bob } = await makePersonWithAgent("Bob", "bob@example.com");
      const aliceDaemon = await makeRegisteredDaemon(alice.person.id);
      const bobDaemon = await makeRegisteredDaemon(bob.person.id);

      const res = await request(makeApp())
        .post(`/runtime/claim?runtime_id=${bobDaemon.runtimeId}`)
        .set("Authorization", `Bearer ${aliceDaemon.token}`)
        .send();

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("runtime_not_owned");
    });

    it("returns 400 when runtime_id query param is missing", async () => {
      const alice = await makeAlice();
      const { token } = await makeRegisteredDaemon(alice.person.id);
      const res = await request(makeApp())
        .post("/runtime/claim")
        .set("Authorization", `Bearer ${token}`)
        .send();
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("missing_runtime_id");
    });

    it("returns 404 when runtime_id is unknown", async () => {
      const alice = await makeAlice();
      const { token } = await makeRegisteredDaemon(alice.person.id);
      const res = await request(makeApp())
        .post("/runtime/claim?runtime_id=rt_ghost")
        .set("Authorization", `Bearer ${token}`)
        .send();
      expect(res.status).toBe(404);
    });
  });

  /* ─── /runtime/events ─────────────────────────────────────────────── */

  describe("POST /runtime/events", () => {
    async function setupClaimedSession() {
      const alice = await makeAlice();
      const a = await makeAgent(alice.person.id);
      const { token, runtimeId: rId, daemonId: dId } = await makeRegisteredDaemon(
        alice.person.id,
      );
      const sid = makeSessionId();
      await sessionRepo.create({
        id: sid,
        agent_id: a.agent.id,
        type: "chat",
        status: "running",
        intent: "hi",
        runtime_id: rId,
      });
      return { token, sid, rId, dId, alice, agent: a.agent };
    }

    it("appends events and updates session.last_event_at", async () => {
      const { token, sid } = await setupClaimedSession();
      const res = await request(makeApp())
        .post("/runtime/events")
        .set("Authorization", `Bearer ${token}`)
        .send({
          events: [
            { session_id: sid, kind: "tool_call", content: "Read", tool_name: "Read" },
            { session_id: sid, kind: "agent", content: "thinking..." },
          ],
        });
      expect(res.status).toBe(204);

      const after = await sessionRepo.findById(sid);
      expect(after?.last_event_at).toBeInstanceOf(Date);
    });

    it("rejects when caller does not own the session's runtime", async () => {
      const { sid } = await setupClaimedSession();
      const { person: bob } = await makePersonWithAgent("Bob", "bob@example.com");
      const bobDaemon = await makeRegisteredDaemon(bob.person.id);

      const res = await request(makeApp())
        .post("/runtime/events")
        .set("Authorization", `Bearer ${bobDaemon.token}`)
        .send({ events: [{ session_id: sid, kind: "agent", content: "x" }] });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("session_not_owned");
    });

    it("returns 400 when body is empty", async () => {
      const { token } = await setupClaimedSession();
      const res = await request(makeApp())
        .post("/runtime/events")
        .set("Authorization", `Bearer ${token}`)
        .send({ events: [] });
      expect(res.status).toBe(400);
    });
  });

  /* ─── /runtime/done ───────────────────────────────────────────────── */

  describe("POST /runtime/done", () => {
    async function setupClaimedSession() {
      const alice = await makeAlice();
      const a = await makeAgent(alice.person.id);
      const { token, runtimeId: rId } = await makeRegisteredDaemon(alice.person.id);
      const sid = makeSessionId();
      await sessionRepo.create({
        id: sid,
        agent_id: a.agent.id,
        type: "chat",
        status: "running",
        intent: "hi",
        runtime_id: rId,
      });
      return { token, sid, rId };
    }

    it("writes terminal state, fires onSessionComplete, returns 204", async () => {
      const { token, sid } = await setupClaimedSession();
      const res = await request(makeApp())
        .post("/runtime/done")
        .set("Authorization", `Bearer ${token}`)
        .send({
          session_id: sid,
          status: "succeeded",
          cli_session_id: "cli-abc",
          result_summary: "done",
          exit_code: 0,
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      expect(res.status).toBe(204);

      const after = await sessionRepo.findById(sid);
      expect(after?.status).toBe("succeeded");
      expect(after?.cli_session_id).toBe("cli-abc");
      expect(after?.completed_at).toBeInstanceOf(Date);
      expect(after?.usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
      // onSessionComplete is fire-and-forget; flush microtasks.
      await new Promise((r) => setTimeout(r, 10));
      expect(onSessionComplete).toHaveBeenCalledOnce();
      expect(onSessionComplete.mock.calls[0]![0].id).toBe(sid);
    });

    it("rejects when caller does not own the session's runtime", async () => {
      const { sid } = await setupClaimedSession();
      const { person: bob } = await makePersonWithAgent("Bob", "bob@example.com");
      const bobDaemon = await makeRegisteredDaemon(bob.person.id);
      const res = await request(makeApp())
        .post("/runtime/done")
        .set("Authorization", `Bearer ${bobDaemon.token}`)
        .send({ session_id: sid, status: "succeeded" });
      expect(res.status).toBe(403);
    });

    it("returns 400 on invalid status", async () => {
      const { token, sid } = await setupClaimedSession();
      const res = await request(makeApp())
        .post("/runtime/done")
        .set("Authorization", `Bearer ${token}`)
        .send({ session_id: sid, status: "running" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_status");
    });

    it("swallows onSessionComplete errors and still returns 204", async () => {
      const { token, sid } = await setupClaimedSession();
      onSessionComplete.mockRejectedValue(new Error("hub down"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const res = await request(makeApp())
        .post("/runtime/done")
        .set("Authorization", `Bearer ${token}`)
        .send({ session_id: sid, status: "failed" });

      expect(res.status).toBe(204);
      await new Promise((r) => setTimeout(r, 10));
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});
