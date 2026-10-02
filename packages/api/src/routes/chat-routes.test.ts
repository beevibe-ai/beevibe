/**
 * `createChatRouter` — the four HTTP handlers, with vitest fakes (no DB).
 *
 * `chat-internals.test.ts` already pins the exported pure helpers
 * (`groupIntoConversations`, `failureMessageFor`, `chainToMessages`).
 * This suite covers the router closure those helpers feed: the human
 * gate, the no-primary-agent shapes, conversation listing + soft
 * delete, `GET /` chain selection and runtime-mismatch detection, and
 * the POST turn ladder (validation → idempotent replay → rate limit →
 * dispatch → offline 503 → resolver success/timeout → onboarding flip).
 *
 * Everything the handlers call is injected, so nothing here spawns a
 * CLI or touches Postgres. `processResponse` and `truncate` run for
 * real — their output is part of the wire contract being pinned.
 */
import express, { json } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentRepository, PersonRepository, RuntimeRepository, Session, SessionRepository } from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import type { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { createChatRouter, type ChatRoutesDeps, type ChatSession } from "./chat.js";

const PERSON = "person_alice";
const AGENT = "agent_alicesteam";
const RUNTIME = "rt_claude_1";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Alice's Team",
    owner_id: PERSON,
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  } as Agent;
}

/**
 * A chat row as `listChatForAgent` returns it. Typed as `Session`
 * (what the port declares) while only carrying the `ChatSession`
 * fields the route actually reads.
 */
function chatSession(overrides: Partial<ChatSession> = {}): Session {
  return {
    id: "sess_aaaaaaaaaaaa",
    agent_id: AGENT,
    type: "chat",
    intent: "hello",
    status: "succeeded",
    result_summary: "hi there",
    created_at: new Date("2026-02-01T00:00:00Z"),
    updated_at: new Date("2026-02-01T00:00:00Z"),
    ...overrides,
  } as Session;
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_aaaaaaaaaaaa",
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    result_summary: "hi there",
    created_at: new Date("2026-02-01T00:00:00Z"),
    updated_at: new Date("2026-02-01T00:00:00Z"),
    ...overrides,
  } as Session;
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
      // Already onboarded by default — the flip path is opted into per case.
      findById: vi.fn(async (id: string) => ({
        id,
        onboarding_completed_at: new Date("2026-01-01T00:00:00Z"),
      })),
      update: vi.fn(async () => undefined),
    } as unknown as PersonRepository,
    runtimeRepo: {
      findById: vi.fn(async () => undefined),
    } as unknown as RuntimeRepository,
    sessionRepo: {
      listChatForAgent: vi.fn(async () => []),
      softDeleteChatChain: vi.fn(async () => 0),
      findById: vi.fn(async () => undefined),
    } as unknown as SessionRepository,
    dispatchService: {
      dispatchTask: vi.fn(async () => ({
        session: fakeSession({ status: "pending" }),
        runtime_id: null,
      })),
    } as unknown as DispatchService,
    chatResolver: {
      register: vi.fn(async () => fakeSession()),
    } as unknown as ChatResolver,
    hub: { isOnline: vi.fn(() => true) } as unknown as DaemonHub,
    ...overrides,
  };
}

/**
 * Stand-in for `createAuthMiddleware` — the handlers only read the
 * `source`/`personId` that `requireHuman` gates on.
 */
function stubAuth(source: "human" | "agent") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.caller =
      source === "human"
        ? { source: "human", agentId: AGENT, hierarchyLevel: "team", personId: PERSON }
        : { source: "agent", agentId: AGENT, hierarchyLevel: "ic" };
    next();
  };
}

function makeApp(ports: Ports, source: "human" | "agent" = "human") {
  const app = express();
  app.use(json());
  app.use("/chat", createChatRouter({ authMiddleware: stubAuth(source), ...ports } as ChatRoutesDeps));
  return app;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── the human gate ───────────────────────────────────────────────────────

describe("human gate", () => {
  it.each([
    ["get", "/chat"],
    ["get", "/chat/conversations"],
    ["delete", "/chat/conversations/sess_head"],
    ["post", "/chat"],
  ] as const)("403s %s %s for an agent token", async (method, path) => {
    const app = makeApp(makePorts(), "agent");
    const res = await request(app)[method](path).send({ message: "hi" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });
});

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /conversations", () => {
  it("returns an empty list when the caller has no primary agent", async () => {
    const ports = makePorts();
    ports.agentRepo.findTopLevelForOwner = vi.fn(async () => undefined);

    const res = await request(makeApp(ports)).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(ports.sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain newest-first with a title, turn count and preview", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [
      chatSession({ id: "sess_oldhead0000", intent: "old thread", result_summary: "old reply" }),
      chatSession({
        id: "sess_newhead0000",
        intent: "new thread",
        result_summary: "new reply",
        created_at: new Date("2026-02-02T00:00:00Z"),
      }),
      chatSession({
        id: "sess_newturn2000",
        prior_session_id: "sess_newhead0000",
        intent: "follow up",
        result_summary: "second   reply\nwrapped",
        created_at: new Date("2026-02-03T00:00:00Z"),
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(ports.sessionRepo.listChatForAgent).toHaveBeenCalledWith(AGENT, 400);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_newhead0000",
        title: "new thread",
        turn_count: 2,
        last_at: "2026-02-03T00:00:00.000Z",
        // Whitespace (including the newline) collapses to single spaces.
        last_preview: "second reply wrapped",
      },
      {
        head_id: "sess_oldhead0000",
        title: "old thread",
        turn_count: 1,
        last_at: "2026-02-01T00:00:00.000Z",
        last_preview: "old reply",
      },
    ]);
  });

  it("truncates a long title and ellipsizes a long preview", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [
      chatSession({ intent: "t".repeat(200), result_summary: "p".repeat(300) }),
    ]);

    const res = await request(makeApp(ports)).get("/chat/conversations");

    const [only] = res.body.conversations;
    expect(only.title.length).toBeLessThanOrEqual(80);
    expect(only.last_preview).toHaveLength(140);
    expect(only.last_preview.endsWith("…")).toBe(true);
  });

  it("previews the error, then the intent, when there is no summary", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [
      chatSession({
        id: "sess_erraaaaaaaa",
        intent: "ignored",
        result_summary: undefined,
        error: "boom from the cli",
      }),
      chatSession({
        id: "sess_bareaaaaaa",
        intent: "only an intent",
        result_summary: undefined,
        created_at: new Date("2026-01-30T00:00:00Z"),
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat/conversations");

    const previews = Object.fromEntries(
      res.body.conversations.map((c: { head_id: string; last_preview: string }) => [
        c.head_id,
        c.last_preview,
      ]),
    );
    expect(previews["sess_erraaaaaaaa"]).toBe("boom from the cli");
    expect(previews["sess_bareaaaaaa"]).toBe("only an intent");
  });

  it("caps the list at 50 conversations", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () =>
      Array.from({ length: 60 }, (_, i) =>
        chatSession({
          id: `sess_${String(i).padStart(12, "0")}`,
          created_at: new Date(2026, 1, 1, 0, i),
        }),
      ),
    );

    const res = await request(makeApp(ports)).get("/chat/conversations");

    expect(res.body.conversations).toHaveLength(50);
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /conversations/:headId", () => {
  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const ports = makePorts();
    ports.sessionRepo.softDeleteChatChain = vi.fn(async () => 3);

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_headaaaaaa");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(ports.sessionRepo.softDeleteChatChain).toHaveBeenCalledWith("sess_headaaaaaa", AGENT);
  });

  it("is idempotent — a second delete reports zero rows", async () => {
    const ports = makePorts();
    ports.sessionRepo.softDeleteChatChain = vi.fn(async () => 0);

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_headaaaaaa");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("404s when the caller has no primary agent", async () => {
    const ports = makePorts();
    ports.agentRepo.findTopLevelForOwner = vi.fn(async () => undefined);

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_headaaaaaa");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
    expect(ports.sessionRepo.softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("500s with a request id when the repo throws, leaking no internals", async () => {
    const ports = makePorts();
    ports.sessionRepo.softDeleteChatChain = vi.fn(async () => {
      throw new Error("deadlock detected on session");
    });

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_headaaaaaa");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    expect(JSON.stringify(res.body)).not.toContain("deadlock");
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /", () => {
  it("returns the null-agent shape when no primary agent exists", async () => {
    const ports = makePorts();
    ports.agentRepo.findTopLevelForOwner = vi.fn(async () => undefined);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns the empty-chain shape when the agent has no chat sessions", async () => {
    const res = await request(makeApp(makePorts())).get("/chat");

    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Alice's Team", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("defaults to the most recent chain and reports its head as conversation_id", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [
      chatSession({ id: "sess_oldhead0000", intent: "old", result_summary: "old reply" }),
      chatSession({
        id: "sess_newhead0000",
        intent: "new",
        result_summary: "new reply",
        created_at: new Date("2026-02-05T00:00:00Z"),
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body.conversation_id).toBe("sess_newhead0000");
    expect(res.body.prior_session_id).toBe("sess_newhead0000");
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "new",
      "new reply",
    ]);
  });

  it("selects the chain named by ?c=", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [
      chatSession({ id: "sess_oldhead0000", intent: "old", result_summary: "old reply" }),
      chatSession({
        id: "sess_newhead0000",
        intent: "new",
        result_summary: "new reply",
        created_at: new Date("2026-02-05T00:00:00Z"),
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat").query({ c: "sess_oldhead0000" });

    expect(res.body.conversation_id).toBe("sess_oldhead0000");
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "old",
      "old reply",
    ]);
  });

  it("returns the empty state rather than 404 for an unknown ?c=", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [chatSession()]);

    const res = await request(makeApp(ports)).get("/chat").query({ c: "sess_nosuchchain" });

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
  });

  it("ignores a repeated ?c= (array) and falls back to the newest chain", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [chatSession({ id: "sess_onlyhead000" })]);

    const res = await request(makeApp(ports)).get("/chat?c=a&c=b");

    // `typeof req.query.c === "string"` is false for an array → no request.
    expect(res.body.conversation_id).toBe("sess_onlyhead000");
  });

  it("keeps only the last 25 sessions of a long chain", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () =>
      Array.from({ length: 40 }, (_, i) =>
        chatSession({
          id: `sess_${String(i).padStart(12, "0")}`,
          prior_session_id: i === 0 ? undefined : `sess_${String(i - 1).padStart(12, "0")}`,
          intent: `turn ${i}`,
          result_summary: `reply ${i}`,
          created_at: new Date(2026, 1, 1, 0, i),
        }),
      ),
    );

    const res = await request(makeApp(ports)).get("/chat");

    // HISTORY_LIMIT / 2, rounded up → 25 sessions × 2 messages.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].content).toBe("turn 15");
    expect(res.body.conversation_id).toBe("sess_000000000000");
  });

  it("renders a failed turn in history with the friendly failure message", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [
      chatSession({
        id: "sess_failedaaaaa",
        intent: "do the thing",
        status: "failed",
        result_summary: undefined,
        error: "CLI exited with code 1",
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body.messages).toEqual([
      { id: "u_sess_failedaaaaa", role: "user", content: "do the thing" },
      {
        id: "a_sess_failedaaaaa",
        role: "agent",
        content: expect.stringContaining("beevibe-daemon start"),
        session_id: "sess_failedaaaaa",
      },
    ]);
  });

  it("renders a system-wake turn as a system message carrying the summary", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [
      chatSession({
        id: "sess_wakeaaaaaaa",
        intent: "<system-wake>CI went red on main\n\nDecide next steps.</system-wake>",
        result_summary: "Looking into it.",
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body.messages[0]).toEqual({
      id: "w_sess_wakeaaaaaaa",
      role: "system",
      content: "CI went red on main",
      session_id: "sess_wakeaaaaaaa",
    });
  });

  it("flags the tail session as in flight while it is still running", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [
      chatSession({ id: "sess_running0000", status: "running", result_summary: undefined }),
    ]);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body.in_flight_session_id).toBe("sess_running0000");
  });

  it("omits in_flight_session_id once the tail session is terminal", async () => {
    const res = await request(
      makeApp(
        makePorts({
          sessionRepo: {
            listChatForAgent: vi.fn(async () => [chatSession({ status: "succeeded" })]),
            softDeleteChatChain: vi.fn(),
            findById: vi.fn(),
          } as unknown as SessionRepository,
        }),
      ),
    ).get("/chat");

    expect(res.body).not.toHaveProperty("in_flight_session_id");
  });

  it("surfaces a runtime mismatch when the chain is pinned to another cli", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [chatSession({ runtime_id: RUNTIME })]);
    ports.runtimeRepo.findById = vi.fn(async () => ({ id: RUNTIME, cli: "codex" }) as never);

    const res = await request(makeApp(ports)).get("/chat");

    expect(ports.runtimeRepo.findById).toHaveBeenCalledWith(RUNTIME);
    expect(res.body.runtime_mismatch).toEqual({ pinned_cli: "codex", current_cli: "claude" });
  });

  it.each([
    ["the pinned cli matches the agent's", async () => ({ id: RUNTIME, cli: "claude" })],
    ["the runtime row is gone", async () => undefined],
    ["the pinned cli is not a known cli", async () => ({ id: RUNTIME, cli: "hand-rolled" })],
  ])("omits runtime_mismatch when %s", async (_label, findById) => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [chatSession({ runtime_id: RUNTIME })]);
    ports.runtimeRepo.findById = findById as never;

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body).not.toHaveProperty("runtime_mismatch");
  });

  it("skips the runtime lookup entirely for an unpinned chain", async () => {
    const ports = makePorts();
    ports.sessionRepo.listChatForAgent = vi.fn(async () => [chatSession({ runtime_id: undefined })]);

    const res = await request(makeApp(ports)).get("/chat");

    expect(ports.runtimeRepo.findById).not.toHaveBeenCalled();
    expect(res.body).not.toHaveProperty("runtime_mismatch");
  });
});

// ── POST /chat ───────────────────────────────────────────────────────────

describe("POST / — request validation", () => {
  it.each([
    ["an absent body", undefined],
    ["an empty object", {}],
    ["a blank message", { message: "   " }],
    ["a non-string message", { message: 42 }],
  ])("400s on %s", async (_label, body) => {
    const ports = makePorts();

    const res = await request(makeApp(ports)).post("/chat").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const ports = makePorts();
    ports.agentRepo.findTopLevelForOwner = vi.fn(async () => undefined);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
  });

  it("trims the message and dispatches a fresh turn", async () => {
    const ports = makePorts();

    const res = await request(makeApp(ports)).post("/chat").send({ message: "  hi there \n" });

    expect(res.status).toBe(200);
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      intent: "hi there",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
  });

  it("pins a continuation to the prior session", async () => {
    const ports = makePorts();

    await request(makeApp(ports))
      .post("/chat")
      .send({ message: "and then?", prior_session_id: "sess_prioraaaaaa" });

    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_prioraaaaaa" },
      }),
    );
  });

  it("ignores a non-string prior_session_id", async () => {
    const ports = makePorts();

    await request(makeApp(ports)).post("/chat").send({ message: "hi", prior_session_id: 7 });

    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ reason: { kind: "fresh" } }),
    );
  });

  it.each([
    ["a well-formed caller session id", "sess_abc123DEF456", "sess_abc123DEF456"],
    ["a too-short id", "sess_short", undefined],
    ["an id with the wrong prefix", "task_abc123DEF456", undefined],
    ["an id with illegal characters", "sess_abc-123DEF45", undefined],
  ])("passes %s through as sessionIdOverride → %s", async (_label, sent, expected) => {
    const ports = makePorts();

    await request(makeApp(ports)).post("/chat").send({ message: "hi", session_id: sent });

    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: expected }),
    );
    // A malformed id is also never looked up for replay.
    expect(ports.sessionRepo.findById).toHaveBeenCalledTimes(expected ? 1 : 0);
  });
});

describe("POST / — idempotent replay", () => {
  const CALLER_SESSION = "sess_abc123DEF456";

  it("replays a succeeded turn without dispatching again", async () => {
    const ports = makePorts();
    ports.sessionRepo.findById = vi.fn(async () =>
      fakeSession({ id: CALLER_SESSION, result_summary: "cached reply" }),
    );

    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SESSION });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      replayed: true,
      session_id: CALLER_SESSION,
      response: "cached reply",
      status: "succeeded",
    });
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed turn with the friendly failure message", async () => {
    const ports = makePorts();
    ports.sessionRepo.findById = vi.fn(async () =>
      fakeSession({
        id: CALLER_SESSION,
        status: "failed",
        result_summary: undefined,
        error: "ENOENT: claude not found",
      }),
    );

    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SESSION });

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.response).toBe("ENOENT: claude not found");
  });

  it("409s while the prior turn for that id is still running", async () => {
    const ports = makePorts();
    ports.sessionRepo.findById = vi.fn(async () =>
      fakeSession({ id: CALLER_SESSION, status: "running" }),
    );

    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SESSION });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the id collides with another caller's session", async () => {
    const ports = makePorts();
    ports.sessionRepo.findById = vi.fn(async () =>
      fakeSession({ id: CALLER_SESSION, agent_id: "agent_someoneelse" }),
    );

    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SESSION });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
  });

  it.each([
    ["the row does not exist", async () => undefined],
    ["the row is not a chat session", async () => fakeSession({ type: "task" })],
    ["the row is still pending", async () => fakeSession({ status: "pending" })],
  ])("falls through to dispatch when %s", async (_label, findById) => {
    const ports = makePorts();
    ports.sessionRepo.findById = findById as never;

    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SESSION });

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBeUndefined();
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledOnce();
  });
});

describe("POST / — rate limiting", () => {
  it("429s with Retry-After once the concurrent slot is taken", async () => {
    const ports = makePorts({ rateLimiter: new ChatRateLimiter({ maxConcurrent: 0 }) });

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("turn_in_flight");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("429s as rate_limited once the sliding window is full", async () => {
    const ports = makePorts({ rateLimiter: new ChatRateLimiter({ maxPerWindow: 0 }) });

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.body.retry_after_ms).toBeDefined();
  });

  it("releases the slot after a turn so the next one gets through", async () => {
    const ports = makePorts({ rateLimiter: new ChatRateLimiter({ maxConcurrent: 1 }) });
    const app = makeApp(ports);

    const first = await request(app).post("/chat").send({ message: "hi" });
    const second = await request(app).post("/chat").send({ message: "again" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("releases the slot when dispatch throws", async () => {
    const ports = makePorts({ rateLimiter: new ChatRateLimiter({ maxConcurrent: 1 }) });
    ports.dispatchService.dispatchTask = vi
      .fn()
      .mockRejectedValueOnce(new Error("insert failed"))
      .mockResolvedValue({ session: fakeSession({ status: "pending" }), runtime_id: null });
    const app = makeApp(ports);

    const first = await request(app).post("/chat").send({ message: "hi" });
    const second = await request(app).post("/chat").send({ message: "again" });

    expect(first.status).toBe(500);
    expect(first.body.error).toBe("internal_error");
    expect(second.status).toBe(200);
  });

  it("releases the slot when the daemon is offline", async () => {
    const ports = makePorts({ rateLimiter: new ChatRateLimiter({ maxConcurrent: 1 }) });
    ports.dispatchService.dispatchTask = vi.fn(async () => ({
      session: fakeSession({ status: "pending" }),
      runtime_id: RUNTIME,
    }));
    ports.hub.isOnline = vi.fn(() => false);
    const app = makeApp(ports);

    const first = await request(app).post("/chat").send({ message: "hi" });
    const second = await request(app).post("/chat").send({ message: "again" });

    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
  });
});

describe("POST / — dispatch and daemon reachability", () => {
  it("503s when the session is pinned to an offline daemon", async () => {
    const ports = makePorts();
    ports.dispatchService.dispatchTask = vi.fn(async () => ({
      session: fakeSession({ status: "pending" }),
      runtime_id: RUNTIME,
    }));
    ports.hub.isOnline = vi.fn(() => false);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(ports.hub.isOnline).toHaveBeenCalledWith(RUNTIME);
    expect(ports.chatResolver.register).not.toHaveBeenCalled();
  });

  it("never consults the hub for a null-runtime (executor fallback) session", async () => {
    const ports = makePorts();

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(ports.hub.isOnline).not.toHaveBeenCalled();
  });

  it("proceeds when the pinned daemon is online", async () => {
    const ports = makePorts();
    ports.dispatchService.dispatchTask = vi.fn(async () => ({
      session: fakeSession({ status: "pending" }),
      runtime_id: RUNTIME,
    }));

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(ports.chatResolver.register).toHaveBeenCalledWith("sess_aaaaaaaaaaaa", 90_000);
  });
});

describe("POST / — turn resolution", () => {
  it("returns the resolved turn with the agent envelope", async () => {
    const ports = makePorts();

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Alice's Team", hierarchy: "team" },
      session_id: "sess_aaaaaaaaaaaa",
      response: "hi there",
      status: "succeeded",
      view_refs: [],
    });
  });

  it("maps a failed turn to the friendly failure message", async () => {
    const ports = makePorts();
    ports.chatResolver.register = vi.fn(async () =>
      fakeSession({
        status: "failed",
        result_summary: undefined,
        error: "CLI exited with code 1",
      }),
    );

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    // Bare exit lines are swapped for the daemon-log pointer.
    expect(res.body.response).toContain("beevibe-daemon start");
  });

  it("504s when the resolver times out", async () => {
    const ports = makePorts();
    ports.chatResolver.register = vi.fn(async () => {
      throw new Error("chat resolver timeout (90000ms) for sess_x");
    });

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ error: "chat_turn_timeout", timeout_ms: 90_000 });
    expect(res.body.message).toContain("90s");
  });

  it("500s on a non-timeout resolver rejection", async () => {
    const ports = makePorts();
    ports.chatResolver.register = vi.fn(async () => {
      throw new Error("resolver collision");
    });

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });

  it("flips onboarding_completed_at on the first succeeded turn", async () => {
    const ports = makePorts();
    ports.personRepo.findById = vi.fn(async (id: string) => ({ id }) as never);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(ports.personRepo.update).toHaveBeenCalledWith(PERSON, {
      onboarding_completed_at: expect.any(Date),
    });
  });

  it("leaves an already-stamped onboarding_completed_at alone", async () => {
    // makePorts' default person is already onboarded.
    const ports = makePorts();

    await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(ports.personRepo.update).not.toHaveBeenCalled();
  });

  it("treats a missing person row as still onboarding and flips", async () => {
    // `!person?.onboarding_completed_at` is true for an absent row, so the
    // flip is attempted; the write is a no-op against a row that isn't there.
    const ports = makePorts();
    ports.personRepo.findById = vi.fn(async () => undefined);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(ports.personRepo.update).toHaveBeenCalledOnce();
  });

  it("does not flip onboarding when the first turn fails", async () => {
    const ports = makePorts();
    ports.personRepo.findById = vi.fn(async (id: string) => ({ id }) as never);
    ports.chatResolver.register = vi.fn(async () => fakeSession({ status: "failed" }));

    await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(ports.personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers the turn when the onboarding flip write fails", async () => {
    const ports = makePorts();
    ports.personRepo.findById = vi.fn(async (id: string) => ({ id }) as never);
    ports.personRepo.update = vi.fn(async () => {
      throw new Error("pg write failed");
    });

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe("hi there");
  });
});
