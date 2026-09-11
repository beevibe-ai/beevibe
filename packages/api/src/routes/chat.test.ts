/**
 * /chat route handlers — unit tests with vitest fakes (no DB, no daemon).
 *
 * `chat-internals.test.ts` already covers the exported pure helpers
 * (groupIntoConversations, chainToMessages, failureMessageFor). This
 * file covers the four handlers wrapped around them, where the
 * product-visible behaviour actually lives:
 *
 *   - GET  /chat/conversations   sidebar list (titles, previews, counts)
 *   - DEL  /chat/conversations/:headId  soft-delete, scoped to the caller
 *   - GET  /chat                 history + the runtime-pin mismatch banner
 *   - POST /chat                 the money path: idempotent replay, rate
 *                                limiting, offline-daemon 503, resolver
 *                                timeout 504, onboarding flip
 *
 * POST in particular has five distinct ways to refuse a turn before it
 * ever spawns a CLI subprocess, each with its own status code the web
 * client branches on — and each one costs real money when it regresses
 * open.
 */

import express, { json } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  Person,
  PersonRepository,
  RuntimeRepository,
  Session,
  SessionRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { createChatRouter, type ChatRoutesDeps } from "./chat.js";

const PERSON = "person_1";
const AGENT = "agent_team";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Hive",
    owner_id: PERSON,
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function fakePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: PERSON,
    name: "Ada",
    email: "ada@example.com",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Person;
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_aaaaaaaaaaaa",
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-04-01T10:00:00Z"),
    updated_at: new Date("2026-04-01T10:00:00Z"),
    ...overrides,
  } as Session;
}

interface Harness {
  app: express.Express;
  agentRepo: { findTopLevelForOwner: ReturnType<typeof vi.fn> };
  personRepo: {
    findById: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  runtimeRepo: { findById: ReturnType<typeof vi.fn> };
  sessionRepo: {
    listChatForAgent: ReturnType<typeof vi.fn>;
    softDeleteChatChain: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  dispatchService: { dispatchTask: ReturnType<typeof vi.fn> };
  chatResolver: { register: ReturnType<typeof vi.fn> };
  hub: { isOnline: ReturnType<typeof vi.fn> };
}

function harness(
  opts: {
    caller?: unknown;
    agent?: Agent | null;
    person?: Person | undefined;
    rateLimiter?: ChatRateLimiter;
  } = {},
): Harness {
  const agentRepo = {
    findTopLevelForOwner: vi.fn(async () =>
      opts.agent === undefined ? fakeAgent() : (opts.agent ?? undefined),
    ),
  };
  const personRepo = {
    findById: vi.fn(async () =>
      "person" in opts ? opts.person : fakePerson(),
    ),
    update: vi.fn(async () => fakePerson()),
  };
  const runtimeRepo = { findById: vi.fn(async () => undefined) };
  const sessionRepo = {
    listChatForAgent: vi.fn(async () => [] as Session[]),
    softDeleteChatChain: vi.fn(async () => 0),
    findById: vi.fn(async () => undefined),
  };
  const dispatchService = {
    dispatchTask: vi.fn(async () => ({
      session: fakeSession({ status: "pending" }),
      runtime_id: undefined,
    })),
  };
  const chatResolver = {
    register: vi.fn(async () =>
      fakeSession({ status: "succeeded", result_summary: "hi there" }),
    ),
  };
  const hub = { isOnline: vi.fn(() => true) };

  const deps: ChatRoutesDeps = {
    authMiddleware: (req, _res, next) => {
      (req as unknown as { caller: unknown }).caller =
        "caller" in opts ? opts.caller : { source: "human", personId: PERSON };
      next();
    },
    agentRepo: agentRepo as unknown as AgentRepository,
    personRepo: personRepo as unknown as PersonRepository,
    runtimeRepo: runtimeRepo as unknown as RuntimeRepository,
    sessionRepo: sessionRepo as unknown as SessionRepository,
    dispatchService: dispatchService as unknown as DispatchService,
    chatResolver: chatResolver as unknown as ChatResolver,
    hub: hub as unknown as DaemonHub,
    rateLimiter: opts.rateLimiter,
  };

  const app = express();
  app.use(json());
  app.use("/chat", createChatRouter(deps));
  return {
    app,
    agentRepo,
    personRepo,
    runtimeRepo,
    sessionRepo,
    dispatchService,
    chatResolver,
    hub,
  };
}

const AGENT_CALLER = { source: "agent", agentId: "agent_x" };

describe("GET /chat/conversations", () => {
  it("rejects a non-human caller", async () => {
    const h = harness({ caller: AGENT_CALLER });
    const res = await request(h.app).get("/chat/conversations");

    expect(res.status).toBe(403);
    expect(h.sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const h = harness({ agent: null });
    const res = await request(h.app).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
  });

  it("summarises each chain with its title, turn count and last activity", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({
        id: "sess_head00000001",
        intent: "Ship the release",
        result_summary: "first",
        created_at: new Date("2026-04-01T10:00:00Z"),
      }),
      fakeSession({
        id: "sess_tail00000001",
        prior_session_id: "sess_head00000001",
        intent: "and now the changelog",
        result_summary: "done: changelog written",
        created_at: new Date("2026-04-01T11:00:00Z"),
      }),
    ]);

    const res = await request(h.app).get("/chat/conversations");

    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head00000001",
        title: "Ship the release",
        turn_count: 2,
        last_at: "2026-04-01T11:00:00.000Z",
        last_preview: "done: changelog written",
      },
    ]);
  });

  it("previews the intent when a turn produced neither summary nor error", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({ id: "sess_pending00001", intent: "what's up", status: "running" }),
    ]);

    const res = await request(h.app).get("/chat/conversations");

    expect(res.body.conversations[0].last_preview).toBe("what's up");
  });

  it("previews the error when a turn failed without a summary", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({
        id: "sess_failed000001",
        status: "failed",
        result_summary: undefined,
        error: "the daemon went away",
      }),
    ]);

    const res = await request(h.app).get("/chat/conversations");

    expect(res.body.conversations[0].last_preview).toBe("the daemon went away");
  });

  it("collapses whitespace and ellipsises a long preview", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({ result_summary: `a  b\n\nc ${"x".repeat(200)}` }),
    ]);

    const res = await request(h.app).get("/chat/conversations");
    const preview = res.body.conversations[0].last_preview as string;

    expect(preview).toHaveLength(140);
    expect(preview.startsWith("a b c ")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("caps the list at 50 conversations", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce(
      Array.from({ length: 60 }, (_, i) =>
        fakeSession({
          id: `sess_${String(i).padStart(12, "0")}`,
          created_at: new Date(2026, 3, 1, i),
        }),
      ),
    );

    const res = await request(h.app).get("/chat/conversations");

    expect(res.body.conversations).toHaveLength(50);
  });
});

describe("DELETE /chat/conversations/:headId", () => {
  it("rejects a non-human caller", async () => {
    const h = harness({ caller: AGENT_CALLER });
    const res = await request(h.app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(403);
    expect(h.sessionRepo.softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const h = harness({ agent: null });
    const res = await request(h.app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "agent_not_found" });
  });

  it("soft-deletes the chain scoped to the caller's own agent", async () => {
    const h = harness();
    h.sessionRepo.softDeleteChatChain.mockResolvedValueOnce(3);

    const res = await request(h.app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(h.sessionRepo.softDeleteChatChain).toHaveBeenCalledWith(
      "sess_head00000001",
      AGENT,
    );
  });

  it("is idempotent — a chain already deleted reports zero rows, not an error", async () => {
    const h = harness();
    h.sessionRepo.softDeleteChatChain.mockResolvedValueOnce(0);

    const res = await request(h.app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("returns a 500 with a request id when the repo throws", async () => {
    const h = harness();
    h.sessionRepo.softDeleteChatChain.mockRejectedValueOnce(new Error("boom"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await request(h.app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "internal_error" });
    // The detail stays server-side; the client gets a paste-able id.
    expect(res.body.request_id).toMatch(/^req_/);
    expect(res.body.message).not.toContain("boom");
    logged.mockRestore();
  });
});

describe("GET /chat", () => {
  it("rejects a non-human caller", async () => {
    const h = harness({ caller: AGENT_CALLER });
    const res = await request(h.app).get("/chat");

    expect(res.status).toBe(403);
  });

  it("returns a null agent and empty history when none is provisioned", async () => {
    const h = harness({ agent: null });
    const res = await request(h.app).get("/chat");

    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns the most recent chain by default", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({
        id: "sess_old000000001",
        intent: "older",
        result_summary: "older reply",
        created_at: new Date("2026-04-01T09:00:00Z"),
      }),
      fakeSession({
        id: "sess_new000000001",
        intent: "newer",
        result_summary: "newer reply",
        created_at: new Date("2026-04-02T09:00:00Z"),
      }),
    ]);

    const res = await request(h.app).get("/chat");

    expect(res.body.conversation_id).toBe("sess_new000000001");
    expect(res.body.prior_session_id).toBe("sess_new000000001");
    expect(res.body.agent).toEqual({ id: AGENT, name: "Hive", hierarchy: "team" });
    expect(res.body.messages).toMatchObject([
      { role: "user", content: "newer" },
      { role: "agent", content: "newer reply", session_id: "sess_new000000001" },
    ]);
  });

  it("selects the chain named by ?c=", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({
        id: "sess_old000000001",
        intent: "older",
        result_summary: "older reply",
        created_at: new Date("2026-04-01T09:00:00Z"),
      }),
      fakeSession({
        id: "sess_new000000001",
        intent: "newer",
        created_at: new Date("2026-04-02T09:00:00Z"),
      }),
    ]);

    const res = await request(h.app).get("/chat?c=sess_old000000001");

    expect(res.body.conversation_id).toBe("sess_old000000001");
  });

  it("renders the empty state rather than 404 for an unknown ?c=", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([fakeSession()]);

    const res = await request(h.app).get("/chat?c=sess_nonexistent1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Hive", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("truncates history to the last 25 sessions", async () => {
    const h = harness();
    const chain = Array.from({ length: 40 }, (_, i) =>
      fakeSession({
        id: `sess_${String(i).padStart(12, "0")}`,
        prior_session_id:
          i === 0 ? undefined : `sess_${String(i - 1).padStart(12, "0")}`,
        intent: `turn ${i}`,
        result_summary: `reply ${i}`,
        created_at: new Date(2026, 3, 1, i),
      }),
    );
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce(chain);

    const res = await request(h.app).get("/chat");

    // 25 sessions × (user + agent) bubbles.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0]).toMatchObject({
      role: "user",
      content: "turn 15",
    });
  });

  it("surfaces the tail session id while a turn is still in flight", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({ id: "sess_running00001", status: "running" }),
    ]);

    const res = await request(h.app).get("/chat");

    expect(res.body.in_flight_session_id).toBe("sess_running00001");
  });

  it("omits in_flight_session_id once the tail session is terminal", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({ status: "succeeded", result_summary: "done" }),
    ]);

    const res = await request(h.app).get("/chat");

    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("flags a runtime mismatch when the chain is pinned to another CLI", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({ runtime_id: "rt_1", result_summary: "hi" }),
    ]);
    h.runtimeRepo.findById.mockResolvedValueOnce({ id: "rt_1", cli: "codex" });

    const res = await request(h.app).get("/chat");

    expect(res.body.runtime_mismatch).toEqual({
      pinned_cli: "codex",
      current_cli: "claude",
    });
  });

  it("omits the mismatch when the pinned CLI matches the agent's", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({ runtime_id: "rt_1", result_summary: "hi" }),
    ]);
    h.runtimeRepo.findById.mockResolvedValueOnce({ id: "rt_1", cli: "claude" });

    const res = await request(h.app).get("/chat");

    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it.each([
    ["the runtime row is gone", undefined],
    ["the runtime's cli is unrecognised", { id: "rt_1", cli: "wingman" }],
  ])("omits the mismatch when %s", async (_label, runtime) => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({ runtime_id: "rt_1", result_summary: "hi" }),
    ]);
    h.runtimeRepo.findById.mockResolvedValueOnce(runtime);

    const res = await request(h.app).get("/chat");

    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("skips the runtime lookup entirely for an unpinned chain", async () => {
    const h = harness();
    h.sessionRepo.listChatForAgent.mockResolvedValueOnce([
      fakeSession({ runtime_id: undefined, result_summary: "hi" }),
    ]);

    await request(h.app).get("/chat");

    expect(h.runtimeRepo.findById).not.toHaveBeenCalled();
  });
});

describe("POST /chat validation and dispatch", () => {
  it("rejects a non-human caller", async () => {
    const h = harness({ caller: AGENT_CALLER });
    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(403);
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["blank", { message: "   " }],
    ["non-string", { message: 42 }],
  ])("400s on a %s message", async (_label, body) => {
    const h = harness();
    const res = await request(h.app).post("/chat").send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "message_required" });
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const h = harness({ agent: null });
    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "no_primary_agent" });
  });

  it("dispatches a fresh chat turn with the trimmed message", async () => {
    const h = harness();
    const res = await request(h.app).post("/chat").send({ message: "  hello  " });

    expect(res.status).toBe(200);
    expect(h.dispatchService.dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      intent: "hello",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
  });

  it("dispatches a continuation when prior_session_id is given", async () => {
    const h = harness();
    await request(h.app)
      .post("/chat")
      .send({ message: "and then?", prior_session_id: "sess_prior000001" });

    expect(h.dispatchService.dispatchTask.mock.calls[0]![0].reason).toEqual({
      kind: "chat_continuation",
      prior_session_id: "sess_prior000001",
    });
  });

  it("honours a well-formed client session id as the override", async () => {
    const h = harness();
    await request(h.app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_ABCdef123456" });

    expect(h.dispatchService.dispatchTask.mock.calls[0]![0].sessionIdOverride).toBe(
      "sess_ABCdef123456",
    );
  });

  it.each([
    ["the wrong prefix", "chat_ABCdef123456"],
    ["the wrong length", "sess_short"],
    ["illegal characters", "sess_ABCdef-23456"],
  ])("ignores a session_id with %s", async (_label, sessionId) => {
    const h = harness();
    await request(h.app).post("/chat").send({ message: "hi", session_id: sessionId });

    expect(h.sessionRepo.findById).not.toHaveBeenCalled();
    expect(h.dispatchService.dispatchTask.mock.calls[0]![0].sessionIdOverride).toBe(
      undefined,
    );
  });

  it("returns the resolved turn with the processed response text", async () => {
    const h = harness();
    h.chatResolver.register.mockResolvedValueOnce(
      fakeSession({ id: "sess_done00000001", result_summary: "all done" }),
    );

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Hive", hierarchy: "team" },
      session_id: "sess_done00000001",
      response: "all done",
      status: "succeeded",
    });
    expect(res.body.replayed).toBeUndefined();
  });

  it("renders a failed turn with the friendly failure message", async () => {
    const h = harness();
    h.chatResolver.register.mockResolvedValueOnce(
      fakeSession({ status: "failed", result_summary: undefined, error: "disk full" }),
    );

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.body).toMatchObject({ status: "failed", response: "disk full" });
  });

  it("500s with a request id when dispatch throws", async () => {
    const h = harness();
    h.dispatchService.dispatchTask.mockRejectedValueOnce(new Error("no runtime"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "internal_error" });
    logged.mockRestore();
  });
});

describe("POST /chat idempotent replay", () => {
  const SID = "sess_ABCdef123456";

  it("replays a succeeded session instead of spawning another turn", async () => {
    const h = harness();
    h.sessionRepo.findById.mockResolvedValueOnce(
      fakeSession({ id: SID, status: "succeeded", result_summary: "cached reply" }),
    );

    const res = await request(h.app)
      .post("/chat")
      .send({ message: "hi", session_id: SID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      session_id: SID,
      response: "cached reply",
      replayed: true,
    });
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed session with its failure message", async () => {
    const h = harness();
    h.sessionRepo.findById.mockResolvedValueOnce(
      fakeSession({
        id: SID,
        status: "failed",
        result_summary: undefined,
        error: "disk full",
      }),
    );

    const res = await request(h.app)
      .post("/chat")
      .send({ message: "hi", session_id: SID });

    expect(res.body).toMatchObject({ replayed: true, response: "disk full" });
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("409s while the session is still running", async () => {
    const h = harness();
    h.sessionRepo.findById.mockResolvedValueOnce(
      fakeSession({ id: SID, status: "running" }),
    );

    const res = await request(h.app)
      .post("/chat")
      .send({ message: "hi", session_id: SID });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "session_in_flight" });
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the session id collides with another caller's session", async () => {
    const h = harness();
    h.sessionRepo.findById.mockResolvedValueOnce(
      fakeSession({ id: SID, agent_id: "agent_someone_else" }),
    );

    const res = await request(h.app)
      .post("/chat")
      .send({ message: "hi", session_id: SID });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "session_belongs_to_other_caller" });
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("falls through to dispatch when the id is unknown", async () => {
    const h = harness();
    h.sessionRepo.findById.mockResolvedValueOnce(undefined);

    await request(h.app).post("/chat").send({ message: "hi", session_id: SID });

    expect(h.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("falls through to dispatch when the id belongs to a non-chat session", async () => {
    const h = harness();
    h.sessionRepo.findById.mockResolvedValueOnce(
      fakeSession({ id: SID, type: "task" }),
    );

    await request(h.app).post("/chat").send({ message: "hi", session_id: SID });

    expect(h.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("falls through to dispatch when a pending row was pre-created", async () => {
    const h = harness();
    h.sessionRepo.findById.mockResolvedValueOnce(
      fakeSession({ id: SID, status: "pending" }),
    );

    await request(h.app).post("/chat").send({ message: "hi", session_id: SID });

    expect(h.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
  });
});

describe("POST /chat rate limiting", () => {
  it("429s with turn_in_flight when a turn is already running for the person", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1000 });
    limiter.acquire(PERSON); // occupy the only slot
    const h = harness({ rateLimiter: limiter });

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "turn_in_flight" });
    expect(res.headers["retry-after"]).toBeDefined();
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("429s with rate_limited once the sliding window is full", async () => {
    const limiter = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 2,
      windowMs: 60_000,
      now: () => 1000,
    });
    const first = limiter.acquire(PERSON);
    first.ok && first.release();
    const second = limiter.acquire(PERSON);
    second.ok && second.release();
    const h = harness({ rateLimiter: limiter });

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "rate_limited" });
    expect(res.body.retry_after_ms).toBe(60_000);
  });

  it("releases the slot after a successful turn, so the next one is admitted", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const h = harness({ rateLimiter: limiter });

    await request(h.app).post("/chat").send({ message: "one" });
    const second = await request(h.app).post("/chat").send({ message: "two" });

    expect(second.status).toBe(200);
    expect(h.dispatchService.dispatchTask).toHaveBeenCalledTimes(2);
  });

  it("releases the slot when dispatch throws", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const h = harness({ rateLimiter: limiter });
    h.dispatchService.dispatchTask.mockRejectedValueOnce(new Error("nope"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await request(h.app).post("/chat").send({ message: "one" });
    const second = await request(h.app).post("/chat").send({ message: "two" });

    expect(second.status).toBe(200);
    logged.mockRestore();
  });

  it("releases the slot when the daemon turns out to be offline", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const h = harness({ rateLimiter: limiter });
    h.dispatchService.dispatchTask.mockResolvedValueOnce({
      session: fakeSession({ status: "pending" }),
      runtime_id: "rt_1",
    });
    h.hub.isOnline.mockReturnValueOnce(false);

    const first = await request(h.app).post("/chat").send({ message: "one" });
    const second = await request(h.app).post("/chat").send({ message: "two" });

    expect(first.status).toBe(503);
    expect(second.status).toBe(200);
  });
});

describe("POST /chat daemon availability and timeouts", () => {
  it("503s when the session is bound to an offline daemon", async () => {
    const h = harness();
    h.dispatchService.dispatchTask.mockResolvedValueOnce({
      session: fakeSession({ status: "pending" }),
      runtime_id: "rt_offline",
    });
    h.hub.isOnline.mockReturnValueOnce(false);

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "agent_offline" });
    expect(h.chatResolver.register).not.toHaveBeenCalled();
  });

  it("proceeds for a null-runtime session without consulting the hub", async () => {
    const h = harness();

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(h.hub.isOnline).not.toHaveBeenCalled();
  });

  it("504s when the resolver times out", async () => {
    const h = harness();
    h.chatResolver.register.mockRejectedValueOnce(
      new Error("chat resolver timeout (90000ms) for sess_x"),
    );

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      error: "chat_turn_timeout",
      timeout_ms: 90_000,
    });
  });

  it("500s on any other resolver rejection", async () => {
    const h = harness();
    h.chatResolver.register.mockRejectedValueOnce(new Error("resolver exploded"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "internal_error" });
    logged.mockRestore();
  });

  it("registers the resolver against the dispatched session with the 90s cap", async () => {
    const h = harness();
    h.dispatchService.dispatchTask.mockResolvedValueOnce({
      session: fakeSession({ id: "sess_dispatched01" }),
      runtime_id: undefined,
    });

    await request(h.app).post("/chat").send({ message: "hi" });

    expect(h.chatResolver.register).toHaveBeenCalledWith("sess_dispatched01", 90_000);
  });
});

describe("POST /chat onboarding flip", () => {
  it("stamps onboarding_completed_at on the first successful turn", async () => {
    const h = harness({ person: fakePerson({ onboarding_completed_at: undefined }) });

    await request(h.app).post("/chat").send({ message: "hi" });

    expect(h.personRepo.update).toHaveBeenCalledWith(
      PERSON,
      expect.objectContaining({ onboarding_completed_at: expect.any(Date) }),
    );
  });

  it("does not re-stamp a person who already completed onboarding", async () => {
    const h = harness({
      person: fakePerson({ onboarding_completed_at: new Date("2026-01-01") }),
    });

    await request(h.app).post("/chat").send({ message: "hi" });

    expect(h.personRepo.update).not.toHaveBeenCalled();
  });

  it("does not stamp when the first turn failed", async () => {
    const h = harness({ person: fakePerson({ onboarding_completed_at: undefined }) });
    h.chatResolver.register.mockResolvedValueOnce(
      fakeSession({ status: "failed", error: "nope" }),
    );

    await request(h.app).post("/chat").send({ message: "hi" });

    expect(h.personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers the turn when the onboarding write rejects", async () => {
    const h = harness({ person: fakePerson({ onboarding_completed_at: undefined }) });
    h.personRepo.update.mockRejectedValueOnce(new Error("write failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    logged.mockRestore();
  });

  it("treats a missing person row as still onboarding", async () => {
    const h = harness({ person: undefined });

    await request(h.app).post("/chat").send({ message: "hi" });

    expect(h.personRepo.update).toHaveBeenCalled();
  });
});
