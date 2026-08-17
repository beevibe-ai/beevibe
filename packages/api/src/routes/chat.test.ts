/**
 * /chat REST surface — unit tests with vitest fakes (no DB, no CLI).
 *
 * `chat-internals.test.ts` already pins the pure helpers
 * (`groupIntoConversations`, `chainToMessages`, `failureMessageFor`).
 * This suite covers the four route handlers those helpers feed, which
 * is where the branchy behaviour lives: the human gate, the
 * no-primary-agent shape each route returns, the idempotent-replay
 * ladder on POST, the rate limiter, the daemon-offline 503, and the
 * 504 timeout.
 *
 * The router is a closure over eight ports, so a bag of `vi.fn()` fakes
 * plus a stub auth middleware reaches every branch. `ChatResolver` and
 * `ChatRateLimiter` are the two real collaborators: the resolver is a
 * plain in-memory Map (registering and resolving from the test is
 * simpler than faking it), and the limiter is constructed with an
 * injected clock so the sliding window is deterministic.
 *
 * `dispatchService.dispatchTask` is faked throughout — the real one
 * inserts a session row and picks a runtime, neither of which this
 * layer's contract depends on beyond `{ session, runtime_id }`.
 */
import express, { json } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_WAKE_INTENT_CLOSE, SYSTEM_WAKE_INTENT_OPEN } from "@beevibe/core";
import type {
  Agent,
  AgentRepository,
  Person,
  PersonRepository,
  Runtime,
  RuntimeRepository,
  Session,
  SessionRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { runtimeMissingError } from "@beevibe/core/adapters/runtime-registry";
import { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { createChatRouter } from "./chat.js";

const PERSON = "person_alice";
const AGENT = "agent_team";
// The route only accepts a caller-supplied session id matching
// /^sess_[A-Za-z0-9]{12}$/ — anything else falls through to the run path.
const VALID_SID = "sess_abcdef123456";

// ── Fixtures ─────────────────────────────────────────────────────────────

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Hive",
    owner_id: PERSON,
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
    ...overrides,
  } as Agent;
}

function fakePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: PERSON,
    email: "alice@example.com",
    onboarding_completed_at: new Date("2026-01-01"),
    created_at: new Date("2026-01-01"),
    updated_at: new Date("2026-01-01"),
    ...overrides,
  } as Person;
}

function fakeSession(overrides: Partial<Session> & Pick<Session, "id">): Session {
  return {
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-06-01T10:00:00Z"),
    ...overrides,
  } as Session;
}

function fakeRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    id: "rt_1",
    daemon_id: "daemon_1",
    cli: "claude",
    capabilities: {},
    created_at: new Date("2026-01-01"),
    ...overrides,
  } as Runtime;
}

// ── Ports ────────────────────────────────────────────────────────────────

function makePorts() {
  const agentRepo = {
    findTopLevelForOwner: vi.fn().mockResolvedValue(fakeAgent()),
  };
  const personRepo = {
    findById: vi.fn().mockResolvedValue(fakePerson()),
    update: vi.fn().mockResolvedValue(fakePerson()),
  };
  const runtimeRepo = { findById: vi.fn().mockResolvedValue(undefined) };
  const sessionRepo = {
    findById: vi.fn().mockResolvedValue(undefined),
    listChatForAgent: vi.fn().mockResolvedValue([]),
    softDeleteChatChain: vi.fn().mockResolvedValue(0),
  };
  const dispatchService = {
    dispatchTask: vi
      .fn()
      .mockResolvedValue({ session: fakeSession({ id: VALID_SID }), runtime_id: null }),
  };
  const hub = { isOnline: vi.fn().mockReturnValue(true) };
  return { agentRepo, personRepo, runtimeRepo, sessionRepo, dispatchService, hub };
}

type Ports = ReturnType<typeof makePorts>;

/**
 * Stand-in for `createAuthMiddleware`. The real one resolves a bv_ token
 * against Postgres; `requireHuman` only reads `caller.source`.
 */
function stubAuth(source: "human" | "agent" | "none") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (source === "human") {
      req.caller = {
        source: "human",
        agentId: AGENT,
        hierarchyLevel: "team",
        personId: PERSON,
      };
    } else if (source === "agent") {
      req.caller = { source: "agent", agentId: AGENT, hierarchyLevel: "ic" };
    }
    next();
  };
}

function makeApp(
  ports: Ports,
  opts: {
    source?: "human" | "agent" | "none";
    chatResolver?: ChatResolver;
    rateLimiter?: ChatRateLimiter;
  } = {},
) {
  const chatResolver = opts.chatResolver ?? new ChatResolver();
  const app = express();
  app.use(json());
  app.use(
    "/chat",
    createChatRouter({
      authMiddleware: stubAuth(opts.source ?? "human"),
      agentRepo: ports.agentRepo as unknown as AgentRepository,
      personRepo: ports.personRepo as unknown as PersonRepository,
      runtimeRepo: ports.runtimeRepo as unknown as RuntimeRepository,
      sessionRepo: ports.sessionRepo as unknown as SessionRepository,
      dispatchService: ports.dispatchService as unknown as DispatchService,
      chatResolver,
      hub: ports.hub as unknown as DaemonHub,
      ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
    }),
  );
  return { app, chatResolver };
}

/**
 * POST a turn and resolve the underlying chat session on the next tick.
 * The route awaits `chatResolver.register(...)`, which only settles when
 * /runtime/done fires — here the test plays that part.
 */
async function postAndResolve(
  ports: Ports,
  body: Record<string, unknown>,
  final: Partial<Session> & Pick<Session, "id">,
  opts: Parameters<typeof makeApp>[1] = {},
) {
  const { app, chatResolver } = makeApp(ports, opts);
  // `resolve` is a no-op returning false until the handler registers,
  // so polling is simpler than racing the await.
  const tick = setInterval(() => {
    if (chatResolver.resolve(final.id, fakeSession(final))) clearInterval(tick);
  }, 5);
  try {
    return await request(app).post("/chat").send(body);
  } finally {
    clearInterval(tick);
  }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /chat/conversations", () => {
  it("403s a non-human caller", async () => {
    for (const source of ["agent", "none"] as const) {
      const res = await request(makeApp(makePorts(), { source }).app).get("/chat/conversations");
      expect(res.status).toBe(403);
    }
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const ports = makePorts();
    ports.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);

    const res = await request(makeApp(ports).app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(ports.sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain with its title, turn count and last preview", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({
        id: "sess_head",
        intent: "ship the linter",
        result_summary: "on it",
        created_at: new Date("2026-06-01T10:00:00Z"),
      }),
      fakeSession({
        id: "sess_tail",
        prior_session_id: "sess_head",
        intent: "and the formatter",
        result_summary: "done — formatter wired up",
        created_at: new Date("2026-06-01T10:05:00Z"),
      }),
    ]);

    const res = await request(makeApp(ports).app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head",
        title: "ship the linter",
        turn_count: 2,
        last_at: "2026-06-01T10:05:00.000Z",
        last_preview: "done — formatter wired up",
      },
    ]);
  });

  it("truncates a long title to CHAT_THREAD_TITLE_MAX", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_head", intent: "z".repeat(200) }),
    ]);

    const { title } = (await request(makeApp(ports).app).get("/chat/conversations")).body
      .conversations[0];
    expect(title.length).toBeLessThanOrEqual(80);
  });

  it("collapses whitespace and ellipsizes an over-long preview", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_head", result_summary: "a\n\n  b " + "c".repeat(300) }),
    ]);

    const { last_preview } = (await request(makeApp(ports).app).get("/chat/conversations")).body
      .conversations[0];
    expect(last_preview).toHaveLength(140);
    expect(last_preview.startsWith("a b ")).toBe(true);
    expect(last_preview.endsWith("…")).toBe(true);
  });

  it("previews the error, then the intent, when there is no summary", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", intent: "one", error: "boom", created_at: new Date(2) }),
      fakeSession({ id: "sess_b", intent: "two", created_at: new Date(1) }),
    ]);

    const byHead = Object.fromEntries(
      (await request(makeApp(ports).app).get("/chat/conversations")).body.conversations.map(
        (c: { head_id: string; last_preview: string }) => [c.head_id, c.last_preview],
      ),
    );
    expect(byHead).toEqual({ sess_a: "boom", sess_b: "two" });
  });

  it("caps the response at 50 conversations even when more come back", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) =>
        fakeSession({ id: `sess_${i}`, created_at: new Date(1_700_000_000_000 + i * 1000) }),
      ),
    );

    const res = await request(makeApp(ports).app).get("/chat/conversations");
    expect(res.body.conversations).toHaveLength(50);
    // Newest first, so the cut drops the oldest.
    expect(res.body.conversations[0].head_id).toBe("sess_59");
    expect(ports.sessionRepo.listChatForAgent).toHaveBeenCalledWith(AGENT, 400);
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /chat/conversations/:headId", () => {
  it("403s a non-human caller", async () => {
    const res = await request(makeApp(makePorts(), { source: "agent" }).app).delete(
      "/chat/conversations/sess_head",
    );
    expect(res.status).toBe(403);
  });

  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const ports = makePorts();
    ports.sessionRepo.softDeleteChatChain.mockResolvedValue(3);

    const res = await request(makeApp(ports).app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(ports.sessionRepo.softDeleteChatChain).toHaveBeenCalledWith("sess_head", AGENT);
  });

  it("is idempotent — re-deleting reports 0 rather than 404ing", async () => {
    const ports = makePorts();
    ports.sessionRepo.softDeleteChatChain.mockResolvedValue(0);

    const res = await request(makeApp(ports).app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("404s when the caller has no primary agent", async () => {
    const ports = makePorts();
    ports.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);

    const res = await request(makeApp(ports).app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
  });

  it("500s with a request id when the repo throws", async () => {
    const ports = makePorts();
    ports.sessionRepo.softDeleteChatChain.mockRejectedValue(new Error("deadlock detected"));

    const res = await request(makeApp(ports).app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // The detail stays server-side.
    expect(JSON.stringify(res.body)).not.toContain("deadlock");
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /chat", () => {
  it("403s a non-human caller", async () => {
    const res = await request(makeApp(makePorts(), { source: "agent" }).app).get("/chat");
    expect(res.status).toBe(403);
  });

  it("returns a null agent and empty history when none is provisioned", async () => {
    const ports = makePorts();
    ports.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);

    const res = await request(makeApp(ports).app).get("/chat");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns the most recent chain by default", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({
        id: "sess_old",
        intent: "old thread",
        result_summary: "old reply",
        created_at: new Date("2026-06-01T09:00:00Z"),
      }),
      fakeSession({
        id: "sess_new",
        intent: "new thread",
        result_summary: "new reply",
        created_at: new Date("2026-06-01T10:00:00Z"),
      }),
    ]);

    const res = await request(makeApp(ports).app).get("/chat");
    expect(res.body.conversation_id).toBe("sess_new");
    expect(res.body.prior_session_id).toBe("sess_new");
    expect(res.body.agent).toEqual({ id: AGENT, name: "Hive", hierarchy: "team" });
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "new thread",
      "new reply",
    ]);
  });

  it("selects a specific chain via ?c=", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_old", intent: "old", created_at: new Date("2026-06-01T09:00:00Z") }),
      fakeSession({ id: "sess_new", intent: "new", created_at: new Date("2026-06-01T10:00:00Z") }),
    ]);

    const res = await request(makeApp(ports).app).get("/chat").query({ c: "sess_old" });
    expect(res.body.conversation_id).toBe("sess_old");
    expect(res.body.messages[0].content).toBe("old");
  });

  it("returns an empty chain — not a 404 — for an unknown ?c=", async () => {
    // The chat UI renders its empty state off this; a 404 would surface
    // as an error toast instead.
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([fakeSession({ id: "sess_a" })]);

    const res = await request(makeApp(ports).app).get("/chat").query({ c: "sess_nope" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Hive", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns an empty chain when the agent has no chat sessions at all", async () => {
    const res = await request(makeApp(makePorts()).app).get("/chat");
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
  });

  it("truncates a long chain to the last 25 sessions", async () => {
    const ports = makePorts();
    const sessions = Array.from({ length: 40 }, (_, i) =>
      fakeSession({
        id: `sess_${i}`,
        ...(i > 0 ? { prior_session_id: `sess_${i - 1}` } : {}),
        intent: `turn ${i}`,
        result_summary: `reply ${i}`,
        created_at: new Date(1_700_000_000_000 + i * 1000),
      }),
    );
    ports.sessionRepo.listChatForAgent.mockResolvedValue(sessions);

    const res = await request(makeApp(ports).app).get("/chat");
    // HISTORY_LIMIT is 50 messages ≈ 25 sessions × 2 messages.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].content).toBe("turn 15");
    // prior_session_id still points at the true tail, not the window's.
    expect(res.body.prior_session_id).toBe("sess_39");
    expect(res.body.conversation_id).toBe("sess_0");
  });

  it("flags an in-flight tail session so the UI can resume its indicator", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", status: "running", intent: "thinking?" }),
    ]);

    const res = await request(makeApp(ports).app).get("/chat");
    expect(res.body.in_flight_session_id).toBe("sess_a");
  });

  it("omits in_flight_session_id once the tail is terminal", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", status: "succeeded", result_summary: "done" }),
    ]);

    const res = await request(makeApp(ports).app).get("/chat");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("renders a system-wake turn as a system message with the summary only", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({
        id: "sess_wake",
        intent: `${SYSTEM_WAKE_INTENT_OPEN}task_1 finished\n\nDecide next steps.${SYSTEM_WAKE_INTENT_CLOSE}`,
        result_summary: "picking it up",
      }),
    ]);

    const res = await request(makeApp(ports).app).get("/chat");
    expect(res.body.messages[0]).toEqual({
      id: "w_sess_wake",
      role: "system",
      content: "task_1 finished",
      session_id: "sess_wake",
    });
  });

  it("reports a runtime mismatch when the chain is pinned to another CLI", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", runtime_id: "rt_codex", result_summary: "ok" }),
    ]);
    ports.runtimeRepo.findById.mockResolvedValue(fakeRuntime({ id: "rt_codex", cli: "codex" }));

    const res = await request(makeApp(ports).app).get("/chat");
    expect(res.body.runtime_mismatch).toEqual({ pinned_cli: "codex", current_cli: "claude" });
    expect(ports.runtimeRepo.findById).toHaveBeenCalledWith("rt_codex");
  });

  it.each([
    ["the tail has no runtime_id", { runtime_id: undefined }, undefined],
    ["the runtime row is gone", { runtime_id: "rt_x" }, undefined],
    ["the pinned CLI matches", { runtime_id: "rt_x" }, fakeRuntime({ cli: "claude" })],
    ["the pinned CLI is unrecognized", { runtime_id: "rt_x" }, fakeRuntime({ cli: "cursor" })],
  ])("omits runtime_mismatch when %s", async (_label, sessionOverrides, runtime) => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", result_summary: "ok", ...sessionOverrides }),
    ]);
    ports.runtimeRepo.findById.mockResolvedValue(runtime);

    const res = await request(makeApp(ports).app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("renders a failed turn with the rewritten runtime-missing message", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({
        id: "sess_a",
        status: "failed",
        intent: "do the thing",
        error: runtimeMissingError("codex"),
      }),
    ]);

    const res = await request(makeApp(ports).app).get("/chat");
    expect(res.body.messages[1].content).toMatch(/pinned to the codex runtime/);
  });
});

// ── POST /chat ───────────────────────────────────────────────────────────

describe("POST /chat — validation and preconditions", () => {
  it("403s a non-human caller", async () => {
    const res = await request(makeApp(makePorts(), { source: "agent" }).app)
      .post("/chat")
      .send({ message: "hi" });
    expect(res.status).toBe(403);
  });

  it.each([
    ["an empty body", {}],
    ["a blank message", { message: "   " }],
    ["a non-string message", { message: 42 }],
  ])("400s on %s", async (_label, body) => {
    const ports = makePorts();
    const res = await request(makeApp(ports).app).post("/chat").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when no team or org agent is provisioned", async () => {
    const ports = makePorts();
    ports.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);

    const res = await request(makeApp(ports).app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
  });
});

describe("POST /chat — dispatch", () => {
  it("dispatches a fresh chat turn and returns the resolved response", async () => {
    const ports = makePorts();
    const res = await postAndResolve(
      ports,
      { message: "  ship the linter  " },
      { id: VALID_SID, status: "succeeded", result_summary: "shipped" },
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Hive", hierarchy: "team" },
      session_id: VALID_SID,
      response: "shipped",
      status: "succeeded",
      view_refs: [],
    });
    expect(res.body.replayed).toBeUndefined();
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      intent: "ship the linter",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
  });

  it("sends a chat_continuation reason when prior_session_id is passed", async () => {
    const ports = makePorts();
    await postAndResolve(
      ports,
      { message: "and the formatter", prior_session_id: "sess_prior" },
      { id: VALID_SID },
    );

    expect(ports.dispatchService.dispatchTask.mock.calls[0]![0].reason).toEqual({
      kind: "chat_continuation",
      prior_session_id: "sess_prior",
    });
  });

  it("passes a well-formed caller session id through as the override", async () => {
    const ports = makePorts();
    await postAndResolve(ports, { message: "hi", session_id: VALID_SID }, { id: VALID_SID });

    expect(ports.dispatchService.dispatchTask.mock.calls[0]![0].sessionIdOverride).toBe(VALID_SID);
  });

  it.each(["sess_short", "notasession", "sess_abcdef12345!", 7])(
    "ignores a malformed session_id (%s) instead of overriding",
    async (session_id) => {
      const ports = makePorts();
      await postAndResolve(ports, { message: "hi", session_id }, { id: VALID_SID });

      expect(ports.dispatchService.dispatchTask.mock.calls[0]![0].sessionIdOverride).toBeUndefined();
      expect(ports.sessionRepo.findById).not.toHaveBeenCalled();
    },
  );

  it("500s and releases the rate slot when dispatch throws", async () => {
    const ports = makePorts();
    ports.dispatchService.dispatchTask.mockRejectedValue(new Error("no runtime"));
    // maxConcurrent defaults to 1, so a leaked slot would 429 the retry.
    const { app } = makeApp(ports);

    const first = await request(app).post("/chat").send({ message: "hi" });
    expect(first.status).toBe(500);
    expect(first.body.error).toBe("internal_error");

    const second = await request(app).post("/chat").send({ message: "hi" });
    expect(second.status).toBe(500);
  });

  it("503s and releases the slot when the bound daemon is offline", async () => {
    const ports = makePorts();
    ports.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: VALID_SID }),
      runtime_id: "rt_1",
    });
    ports.hub.isOnline.mockReturnValue(false);
    const { app } = makeApp(ports);

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(ports.hub.isOnline).toHaveBeenCalledWith("rt_1");

    // Slot released — a retry gets past the limiter to the same 503.
    expect((await request(app).post("/chat").send({ message: "hi" })).status).toBe(503);
  });

  it("does not consult the hub for a null-runtime agent — the executor claims it", async () => {
    const ports = makePorts();
    const res = await postAndResolve(ports, { message: "hi" }, { id: VALID_SID });

    expect(ports.hub.isOnline).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("504s when the turn outlives the resolver timeout", async () => {
    // register()'s own timer rejects; no CLI or clock faking needed —
    // a resolver whose entry is dropped rejects on the next tick.
    const ports = makePorts();
    const chatResolver = new ChatResolver();
    vi.spyOn(chatResolver, "register").mockRejectedValue(
      new Error("chat resolver timeout (90000ms) for sess_x"),
    );

    const res = await request(makeApp(ports, { chatResolver }).app)
      .post("/chat")
      .send({ message: "hi" });

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ error: "chat_turn_timeout", timeout_ms: 90_000 });
  });

  it("500s on a non-timeout resolver rejection", async () => {
    const ports = makePorts();
    const chatResolver = new ChatResolver();
    vi.spyOn(chatResolver, "register").mockRejectedValue(new Error("connection lost"));

    const res = await request(makeApp(ports, { chatResolver }).app)
      .post("/chat")
      .send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });

  it("maps a failed turn onto the friendlier failure message", async () => {
    const ports = makePorts();
    const res = await postAndResolve(
      ports,
      { message: "hi" },
      { id: VALID_SID, status: "failed", error: "CLI exited with code 1" },
    );

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    // The bare exit line is useless; the daemon-log pointer replaces it.
    expect(res.body.response).toMatch(/beevibe-daemon start/);
  });
});

describe("POST /chat — onboarding flip", () => {
  it("stamps onboarding_completed_at on the first successful turn", async () => {
    const ports = makePorts();
    ports.personRepo.findById.mockResolvedValue(
      fakePerson({ onboarding_completed_at: undefined }),
    );

    await postAndResolve(ports, { message: "hi" }, { id: VALID_SID, status: "succeeded" });

    expect(ports.personRepo.update).toHaveBeenCalledWith(PERSON, {
      onboarding_completed_at: expect.any(Date),
    });
  });

  it("leaves the flag alone when the turn failed", async () => {
    const ports = makePorts();
    ports.personRepo.findById.mockResolvedValue(
      fakePerson({ onboarding_completed_at: undefined }),
    );

    await postAndResolve(ports, { message: "hi" }, { id: VALID_SID, status: "failed" });
    expect(ports.personRepo.update).not.toHaveBeenCalled();
  });

  it("skips the write for an already-onboarded person", async () => {
    const ports = makePorts();
    await postAndResolve(ports, { message: "hi" }, { id: VALID_SID, status: "succeeded" });
    expect(ports.personRepo.update).not.toHaveBeenCalled();
  });

  it("still 200s when the flip write rejects — it is fire-and-forget", async () => {
    const ports = makePorts();
    ports.personRepo.findById.mockResolvedValue(
      fakePerson({ onboarding_completed_at: undefined }),
    );
    ports.personRepo.update.mockRejectedValue(new Error("write conflict"));

    const res = await postAndResolve(
      ports,
      { message: "hi" },
      { id: VALID_SID, status: "succeeded", result_summary: "ok" },
    );
    expect(res.status).toBe(200);
    expect(res.body.response).toBe("ok");
  });
});

describe("POST /chat — idempotent replay", () => {
  it("replays a succeeded session without dispatching again", async () => {
    const ports = makePorts();
    ports.sessionRepo.findById.mockResolvedValue(
      fakeSession({ id: VALID_SID, type: "chat", status: "succeeded", result_summary: "cached" }),
    );

    const res = await request(makeApp(ports).app)
      .post("/chat")
      .send({ message: "hi", session_id: VALID_SID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      replayed: true,
      response: "cached",
      status: "succeeded",
      session_id: VALID_SID,
    });
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed session with the failure message", async () => {
    const ports = makePorts();
    ports.sessionRepo.findById.mockResolvedValue(
      fakeSession({ id: VALID_SID, type: "chat", status: "failed", error: "disk full" }),
    );

    const res = await request(makeApp(ports).app)
      .post("/chat")
      .send({ message: "hi", session_id: VALID_SID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replayed: true, status: "failed", response: "disk full" });
  });

  it("409s while the session is still running", async () => {
    const ports = makePorts();
    ports.sessionRepo.findById.mockResolvedValue(
      fakeSession({ id: VALID_SID, type: "chat", status: "running" }),
    );

    const res = await request(makeApp(ports).app)
      .post("/chat")
      .send({ message: "hi", session_id: VALID_SID });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the session id belongs to a different agent", async () => {
    const ports = makePorts();
    ports.sessionRepo.findById.mockResolvedValue(
      fakeSession({ id: VALID_SID, type: "chat", agent_id: "agent_someone_else" }),
    );

    const res = await request(makeApp(ports).app)
      .post("/chat")
      .send({ message: "hi", session_id: VALID_SID });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
  });

  it("runs the turn when the pending row exists but hasn't started", async () => {
    // `pending` is neither terminal nor running — fall through and
    // dispatch under the same id.
    const ports = makePorts();
    ports.sessionRepo.findById.mockResolvedValue(
      fakeSession({ id: VALID_SID, type: "chat", status: "pending" }),
    );

    const res = await postAndResolve(
      ports,
      { message: "hi", session_id: VALID_SID },
      { id: VALID_SID, result_summary: "fresh" },
    );

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBeUndefined();
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the row does not exist", undefined],
    ["the row is not a chat session", fakeSession({ id: VALID_SID, type: "task" })],
  ])("falls through to the run path when %s", async (_label, existing) => {
    const ports = makePorts();
    ports.sessionRepo.findById.mockResolvedValue(existing);

    const res = await postAndResolve(
      ports,
      { message: "hi", session_id: VALID_SID },
      { id: VALID_SID, result_summary: "ran" },
    );

    expect(res.status).toBe(200);
    expect(res.body.response).toBe("ran");
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
  });
});

describe("POST /chat — rate limiting", () => {
  it("429s a concurrent second turn from the same person", async () => {
    const ports = makePorts();
    // Same app across both requests so they share one limiter instance.
    const { app, chatResolver } = makeApp(ports);

    // Kick the first turn off without awaiting it — supertest's Test is
    // lazy, so `.end()` is what actually fires the request. It parks on
    // the resolver, holding the single concurrent slot.
    const first = request(app).post("/chat").send({ message: "first" });
    const firstDone = new Promise<void>((done) => first.end(() => done()));
    await vi.waitFor(() => expect(ports.dispatchService.dispatchTask).toHaveBeenCalled());

    const res = await request(app).post("/chat").send({ message: "second" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("turn_in_flight");
    expect(res.body.retry_after_ms).toBeGreaterThan(0);
    expect(res.headers["retry-after"]).toBeDefined();

    // Let the parked turn finish rather than leaving it pending for the
    // route's full 90s timeout.
    chatResolver.resolve(VALID_SID, fakeSession({ id: VALID_SID }));
    await firstDone;
  });

  it("429s with rate_limited once the sliding window is full", async () => {
    let now = 1_000_000;
    const rateLimiter = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 2,
      windowMs: 60_000,
      now: () => now,
    });
    const ports = makePorts();

    for (let i = 0; i < 2; i++) {
      const ok = await postAndResolve(ports, { message: `turn ${i}` }, { id: VALID_SID }, {
        rateLimiter,
      });
      expect(ok.status).toBe(200);
    }

    const res = await request(makeApp(ports, { rateLimiter }).app)
      .post("/chat")
      .send({ message: "third" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");

    // Past the window, the same caller is admitted again.
    now += 60_001;
    const after = await postAndResolve(ports, { message: "fourth" }, { id: VALID_SID }, {
      rateLimiter,
    });
    expect(after.status).toBe(200);
  });

  it("never reaches dispatch when the limiter refuses", async () => {
    const rateLimiter = new ChatRateLimiter({ maxPerWindow: 0 });
    const ports = makePorts();

    const res = await request(makeApp(ports, { rateLimiter }).app)
      .post("/chat")
      .send({ message: "hi" });

    expect(res.status).toBe(429);
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });
});
