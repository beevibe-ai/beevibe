/**
 * `createChatRouter` — the human chat surface, unit-tested with vitest
 * fakes (no DB, no CLI).
 *
 * The pure helpers (`groupIntoConversations`, `chainToMessages`,
 * `failureMessageFor`) are pinned by `chat-internals.test.ts`. This
 * suite covers the four handlers around them, which is where the
 * product-critical branching lives: the human gate, the primary-agent
 * lookups, idempotent replay of a retried POST, the rate limiter, the
 * daemon-offline 503, the resolver timeout 504, and the onboarding
 * flag flip on the first successful turn.
 *
 * Everything the router closes over is a port, so a bag of `vi.fn()`s
 * plus a stub auth middleware reaches every branch. `processResponse`
 * and `truncate` run for real — their output is part of the wire
 * contract these tests are pinning.
 */
import express, { json } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  PersonRepository,
  Runtime,
  RuntimeRepository,
  Session,
  SessionRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { createChatRouter, type ChatRoutesDeps } from "./chat.js";

const PERSON = "person_alice";
const AGENT = "agent_alicesteam";

// ── Fixtures ─────────────────────────────────────────────────────────────

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Alice's Team",
    owner_id: PERSON,
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Agent;
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_aaaaaaaaaaaa",
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-01-02T00:00:00Z"),
    updated_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  } as Session;
}

// ── Fake ports ───────────────────────────────────────────────────────────

function stubAuth(source: "human" | "agent" = "human") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.caller =
      source === "human"
        ? { source: "human", agentId: AGENT, hierarchyLevel: "team", personId: PERSON }
        : { source: "agent", agentId: AGENT, hierarchyLevel: "ic" };
    next();
  };
}

interface Ports {
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  runtimeRepo: RuntimeRepository;
  sessionRepo: SessionRepository;
  dispatchService: DispatchService;
  chatResolver: ChatResolver;
  hub: DaemonHub;
  rateLimiter?: ChatRateLimiter;
}

function makePorts(overrides: Partial<Ports> = {}): Ports {
  return {
    agentRepo: {
      findTopLevelForOwner: vi.fn(async () => fakeAgent()),
    } as unknown as AgentRepository,
    personRepo: {
      findById: vi.fn(async () => ({
        id: PERSON,
        onboarding_completed_at: new Date("2026-01-01T00:00:00Z"),
      })),
      update: vi.fn(async () => undefined),
    } as unknown as PersonRepository,
    runtimeRepo: {
      findById: vi.fn(async () => undefined),
    } as unknown as RuntimeRepository,
    sessionRepo: {
      findById: vi.fn(async () => undefined),
      listChatForAgent: vi.fn(async () => []),
      softDeleteChatChain: vi.fn(async () => 0),
    } as unknown as SessionRepository,
    dispatchService: {
      dispatchTask: vi.fn(async () => ({
        session: fakeSession({ status: "pending" }),
        runtime_id: null,
      })),
    } as unknown as DispatchService,
    chatResolver: {
      register: vi.fn(async () => fakeSession({ result_summary: "done" })),
    } as unknown as ChatResolver,
    hub: { isOnline: vi.fn(() => true) } as unknown as DaemonHub,
    ...overrides,
  };
}

function makeApp(ports: Ports, source: "human" | "agent" = "human") {
  const app = express();
  app.use(json());
  app.use(
    "/chat",
    createChatRouter({ authMiddleware: stubAuth(source), ...ports } as ChatRoutesDeps),
  );
  return app;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /chat/conversations", () => {
  it("403s an agent-token caller", async () => {
    const res = await request(makeApp(makePorts(), "agent")).get("/chat/conversations");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    // Never reaches the session repo when there's nothing to list for.
    expect(ports.sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarises each chain: title, turn count, last activity, preview", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_head00000001",
        intent: "ship the launch checklist",
        created_at: new Date("2026-01-02T10:00:00Z"),
        result_summary: "first reply",
      }),
      fakeSession({
        id: "sess_tail00000001",
        prior_session_id: "sess_head00000001",
        intent: "and the rollout plan",
        created_at: new Date("2026-01-02T10:05:00Z"),
        result_summary: "second   reply\nwith whitespace",
      } as Partial<Session>),
    ]);

    const res = await request(makeApp(ports)).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0]).toMatchObject({
      head_id: "sess_head00000001",
      title: "ship the launch checklist",
      turn_count: 2,
      last_at: "2026-01-02T10:05:00.000Z",
      // Preview is collapsed to a single line off the *last* turn.
      last_preview: "second reply with whitespace",
    });
  });

  it("truncates a long first message into the thread title", async () => {
    const ports = makePorts();
    const longIntent = "x".repeat(200);
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ intent: longIntent }),
    ]);

    const res = await request(makeApp(ports)).get("/chat/conversations");

    expect(res.body.conversations[0].title.length).toBeLessThanOrEqual(80);
    expect(res.body.conversations[0].title.endsWith("…")).toBe(true);
  });

  it("previews the error, then the intent, when a turn produced no summary", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent)
      .mockResolvedValueOnce([
        fakeSession({ id: "sess_err000000a1", error: "boom", result_summary: undefined }),
      ])
      .mockResolvedValueOnce([
        fakeSession({ id: "sess_bare00000a1", result_summary: undefined }),
      ]);

    const app = makeApp(ports);
    const withError = await request(app).get("/chat/conversations");
    const bare = await request(app).get("/chat/conversations");

    expect(withError.body.conversations[0].last_preview).toBe("boom");
    expect(bare.body.conversations[0].last_preview).toBe("hello");
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /chat/conversations/:headId", () => {
  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.softDeleteChatChain).mockResolvedValue(3);

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(ports.sessionRepo.softDeleteChatChain).toHaveBeenCalledWith(
      "sess_head00000001",
      AGENT,
    );
  });

  it("404s when the caller has no primary agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
  });

  it("403s an agent-token caller", async () => {
    const res = await request(makeApp(makePorts(), "agent")).delete(
      "/chat/conversations/sess_head00000001",
    );

    expect(res.status).toBe(403);
  });

  it("turns a repo failure into a 500 with a request id, not a stack trace", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.softDeleteChatChain).mockRejectedValue(
      new Error("connection terminated unexpectedly"),
    );

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    expect(JSON.stringify(res.body)).not.toContain("connection terminated");
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /chat", () => {
  it("403s an agent-token caller", async () => {
    const res = await request(makeApp(makePorts(), "agent")).get("/chat");

    expect(res.status).toBe(403);
  });

  it("returns a null agent and no messages when none is provisioned", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns the most recent chain rehydrated as user/agent messages", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_old000000a1",
        intent: "older thread",
        created_at: new Date("2026-01-01T00:00:00Z"),
        result_summary: "older reply",
      }),
      fakeSession({
        id: "sess_new000000a1",
        intent: "newer thread",
        created_at: new Date("2026-01-03T00:00:00Z"),
        result_summary: "newer reply",
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.status).toBe(200);
    expect(res.body.agent).toEqual({ id: AGENT, name: "Alice's Team", hierarchy: "team" });
    expect(res.body.conversation_id).toBe("sess_new000000a1");
    expect(res.body.prior_session_id).toBe("sess_new000000a1");
    expect(res.body.messages).toEqual([
      { id: "u_sess_new000000a1", role: "user", content: "newer thread" },
      {
        id: "a_sess_new000000a1",
        role: "agent",
        content: "newer reply",
        session_id: "sess_new000000a1",
      },
    ]);
  });

  it("renders a failed turn as an agent message carrying the failure text", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_failed0001",
        intent: "do the thing",
        status: "failed",
        result_summary: undefined,
        error: "claude runtime 'claude' is not installed on this daemon",
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[1]).toMatchObject({
      id: "a_sess_failed0001",
      role: "agent",
      session_id: "sess_failed0001",
    });
    expect(res.body.messages[1].content).toContain("not installed");
  });

  it("selects a specific conversation via ?c=", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_old000000a1",
        intent: "older thread",
        created_at: new Date("2026-01-01T00:00:00Z"),
      }),
      fakeSession({
        id: "sess_new000000a1",
        intent: "newer thread",
        created_at: new Date("2026-01-03T00:00:00Z"),
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat?c=sess_old000000a1");

    expect(res.body.conversation_id).toBe("sess_old000000a1");
    expect(res.body.messages[0].content).toBe("older thread");
  });

  it("renders the empty state (not a 404) for an unknown ?c=", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([fakeSession()]);

    const res = await request(makeApp(ports)).get("/chat?c=sess_nosuchchain");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Alice's Team", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("flags an in-flight tail session so the UI can resume its thinking indicator", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_running0001", status: "running", result_summary: undefined }),
    ]);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body.in_flight_session_id).toBe("sess_running0001");
    // The agent reply slot stays empty until /runtime/done lands.
    expect(res.body.messages).toHaveLength(1);
  });

  it("omits in_flight_session_id once the tail is terminal", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([fakeSession()]);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("surfaces a runtime mismatch when the chain is pinned to another CLI", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ runtime_id: "rt_1" } as Partial<Session>),
    ]);
    vi.mocked(ports.runtimeRepo.findById).mockResolvedValue({
      id: "rt_1",
      cli: "codex",
    } as unknown as Runtime);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body.runtime_mismatch).toEqual({ pinned_cli: "codex", current_cli: "claude" });
  });

  it("stays silent when the pinned runtime matches the agent's current CLI", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ runtime_id: "rt_1" } as Partial<Session>),
    ]);
    vi.mocked(ports.runtimeRepo.findById).mockResolvedValue({
      id: "rt_1",
      cli: "claude",
    } as unknown as Runtime);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("stays silent when the pinned runtime row is gone or runs an unknown CLI", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ runtime_id: "rt_gone" } as Partial<Session>),
    ]);
    vi.mocked(ports.runtimeRepo.findById)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "rt_gone", cli: "totally-unknown" } as unknown as Runtime);

    const app = makeApp(ports);
    const missing = await request(app).get("/chat");
    const unknownCli = await request(app).get("/chat");

    expect(missing.body.runtime_mismatch).toBeUndefined();
    expect(unknownCli.body.runtime_mismatch).toBeUndefined();
  });

  it("skips the runtime lookup entirely for an unpinned chain", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.listChatForAgent).mockResolvedValue([fakeSession()]);

    await request(makeApp(ports)).get("/chat");

    expect(ports.runtimeRepo.findById).not.toHaveBeenCalled();
  });
});

// ── POST /chat ───────────────────────────────────────────────────────────

describe("POST /chat", () => {
  it("403s an agent-token caller", async () => {
    const res = await request(makeApp(makePorts(), "agent"))
      .post("/chat")
      .send({ message: "hi" });

    expect(res.status).toBe(403);
  });

  it("400s on a missing or whitespace-only message", async () => {
    const app = makeApp(makePorts());

    const missing = await request(app).post("/chat").send({});
    const blank = await request(app).post("/chat").send({ message: "   " });

    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("message_required");
    expect(blank.status).toBe(400);
  });

  it("404s when the caller has no primary agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
  });

  it("dispatches a fresh turn and returns the resolved reply", async () => {
    const ports = makePorts();
    vi.mocked(ports.chatResolver.register).mockResolvedValue(
      fakeSession({
        id: "sess_done00000a1",
        result_summary: "shipped it — see sess_aaaaaaaaaaaa",
      }),
    );

    const res = await request(makeApp(ports)).post("/chat").send({ message: "  ship it  " });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Alice's Team", hierarchy: "team" },
      session_id: "sess_done00000a1",
      status: "succeeded",
    });
    // processResponse ran for real: the inline id became a view ref.
    expect(res.body.view_refs).toEqual(["sess_aaaaaaaaaaaa"]);
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT,
        intent: "ship it",
        type: "chat",
        reason: { kind: "fresh" },
      }),
    );
  });

  it("passes prior_session_id through as a chat_continuation resume reason", async () => {
    const ports = makePorts();

    await request(makeApp(ports))
      .post("/chat")
      .send({ message: "and then?", prior_session_id: "sess_prior00001" });

    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_prior00001" },
      }),
    );
  });

  it("honours a well-formed client session_id and ignores a malformed one", async () => {
    const ports = makePorts();
    const app = makeApp(ports);

    await request(app).post("/chat").send({ message: "a", session_id: "sess_abc123DEF456" });
    await request(app).post("/chat").send({ message: "b", session_id: "not-a-session-id" });

    expect(vi.mocked(ports.dispatchService.dispatchTask).mock.calls[0]?.[0]).toMatchObject({
      sessionIdOverride: "sess_abc123DEF456",
    });
    expect(
      vi.mocked(ports.dispatchService.dispatchTask).mock.calls[1]?.[0].sessionIdOverride,
    ).toBeUndefined();
  });

  it("replays a finished turn instead of spawning a second CLI", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.findById).mockResolvedValue(
      fakeSession({ id: "sess_abc123DEF456", result_summary: "already answered" }),
    );

    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abc123DEF456" });

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.response).toBe("already answered");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed turn with the friendly failure message", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.findById).mockResolvedValue(
      fakeSession({
        id: "sess_abc123DEF456",
        status: "failed",
        result_summary: undefined,
        error: "CLI exited with code 1",
      }),
    );

    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abc123DEF456" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    // The bare exit line is swapped for the daemon-log pointer.
    expect(res.body.response).toContain("beevibe-daemon start");
  });

  it("409s while the referenced session is still running", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.findById).mockResolvedValue(
      fakeSession({ id: "sess_abc123DEF456", status: "running" }),
    );

    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abc123DEF456" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
  });

  it("403s when the session id belongs to a different caller's agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.findById).mockResolvedValue(
      fakeSession({ id: "sess_abc123DEF456", agent_id: "agent_someoneelse" }),
    );

    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abc123DEF456" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
  });

  it("falls through to a live dispatch when the id is unknown, non-chat, or still pending", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.findById)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(fakeSession({ id: "sess_abc123DEF456", type: "task" }))
      .mockResolvedValueOnce(fakeSession({ id: "sess_abc123DEF456", status: "pending" }));

    const app = makeApp(ports);
    for (const _ of [0, 1, 2]) {
      const res = await request(app)
        .post("/chat")
        .send({ message: "hi", session_id: "sess_abc123DEF456" });
      expect(res.status).toBe(200);
      expect(res.body.replayed).toBeUndefined();
    }
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledTimes(3);
  });

  it("429s a second concurrent turn and releases the slot afterwards", async () => {
    const ports = makePorts({ rateLimiter: new ChatRateLimiter({ maxConcurrent: 1 }) });
    let unblock: (s: Session) => void = () => {};
    // Only the first turn hangs; later turns fall back to the default
    // immediately-resolving fake.
    vi.mocked(ports.chatResolver.register).mockImplementationOnce(
      () =>
        new Promise<Session>((resolve) => {
          unblock = resolve;
        }),
    );

    const app = makeApp(ports);
    // `.then()` is what actually fires a supertest request — without it
    // the first turn would never reach the handler and the slot would
    // still be free when the second arrives.
    const first = request(app)
      .post("/chat")
      .send({ message: "one" })
      .then((r) => r);
    // Let the first request reach `chatResolver.register` before firing
    // the second, so the concurrency slot is genuinely held.
    await vi.waitFor(() => expect(ports.chatResolver.register).toHaveBeenCalled());

    const second = await request(app).post("/chat").send({ message: "two" });
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("turn_in_flight");
    expect(second.headers["retry-after"]).toBeDefined();

    unblock(fakeSession({ result_summary: "ok" }));
    expect((await first).status).toBe(200);

    // Slot released — a follow-up turn is accepted again.
    const third = await request(app).post("/chat").send({ message: "three" });
    expect(third.status).toBe(200);
  });

  it("429s once the sliding window is exhausted", async () => {
    const ports = makePorts({
      rateLimiter: new ChatRateLimiter({ maxPerWindow: 1, now: () => 1_000 }),
    });

    const app = makeApp(ports);
    expect((await request(app).post("/chat").send({ message: "one" })).status).toBe(200);
    const second = await request(app).post("/chat").send({ message: "two" });

    expect(second.status).toBe(429);
    expect(second.body.error).toBe("rate_limited");
    expect(second.body.retry_after_ms).toBeGreaterThan(0);
  });

  it("503s when the session is bound to an offline daemon", async () => {
    const ports = makePorts();
    vi.mocked(ports.dispatchService.dispatchTask).mockResolvedValue({
      session: fakeSession({ status: "pending" }),
      runtime_id: "rt_offline",
    });
    vi.mocked(ports.hub.isOnline).mockReturnValue(false);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(ports.chatResolver.register).not.toHaveBeenCalled();
  });

  it("proceeds for a null-runtime agent even with no daemon online", async () => {
    const ports = makePorts();
    vi.mocked(ports.hub.isOnline).mockReturnValue(false);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(ports.hub.isOnline).not.toHaveBeenCalled();
  });

  it("504s when the resolver times out", async () => {
    const ports = makePorts();
    vi.mocked(ports.chatResolver.register).mockRejectedValue(
      new Error("chat resolver timeout (90000ms) for sess_aaaaaaaaaaaa"),
    );

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(504);
    expect(res.body.error).toBe("chat_turn_timeout");
    expect(res.body.timeout_ms).toBe(90_000);
  });

  it("500s on a non-timeout resolver failure", async () => {
    const ports = makePorts();
    vi.mocked(ports.chatResolver.register).mockRejectedValue(new Error("resolver exploded"));

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });

  it("500s and releases the rate-limit slot when dispatch throws", async () => {
    const ports = makePorts({ rateLimiter: new ChatRateLimiter({ maxConcurrent: 1 }) });
    vi.mocked(ports.dispatchService.dispatchTask).mockRejectedValueOnce(
      new Error("insert failed"),
    );

    const app = makeApp(ports);
    const failed = await request(app).post("/chat").send({ message: "hi" });
    expect(failed.status).toBe(500);

    // If the slot had leaked, this would come back 429.
    const retry = await request(app).post("/chat").send({ message: "hi" });
    expect(retry.status).toBe(200);
  });

  it("flips onboarding_completed_at on the first successful turn", async () => {
    const ports = makePorts();
    vi.mocked(ports.personRepo.findById).mockResolvedValue({
      id: PERSON,
      onboarding_completed_at: null,
    } as unknown as Awaited<ReturnType<PersonRepository["findById"]>>);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(ports.personRepo.update).toHaveBeenCalledWith(
      PERSON,
      expect.objectContaining({ onboarding_completed_at: expect.any(Date) }),
    );
  });

  it("does not re-flip onboarding for an already-onboarded person", async () => {
    const ports = makePorts();

    await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(ports.personRepo.update).not.toHaveBeenCalled();
  });

  it("does not flip onboarding when the first turn failed", async () => {
    const ports = makePorts();
    vi.mocked(ports.personRepo.findById).mockResolvedValue({
      id: PERSON,
      onboarding_completed_at: null,
    } as unknown as Awaited<ReturnType<PersonRepository["findById"]>>);
    vi.mocked(ports.chatResolver.register).mockResolvedValue(
      fakeSession({ status: "failed", result_summary: undefined, error: "nope" }),
    );

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.response).toBe("nope");
    expect(ports.personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers the turn when the onboarding flip write fails", async () => {
    const ports = makePorts();
    vi.mocked(ports.personRepo.findById).mockResolvedValue({
      id: PERSON,
      onboarding_completed_at: null,
    } as unknown as Awaited<ReturnType<PersonRepository["findById"]>>);
    vi.mocked(ports.personRepo.update).mockRejectedValue(new Error("write failed"));

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
  });
});
