/**
 * `createChatRouter` — unit tests with vitest fakes (no DB).
 *
 * `chat-internals.test.ts` already covers the exported pure helpers
 * (`groupIntoConversations`, `chainToMessages`, `failureMessageFor`).
 * This file covers the four handlers those helpers feed, which is where
 * the route's real risk lives: the idempotent-replay ladder (403/409/
 * 200-replayed) that stops a double-submit from paying for a second CLI
 * turn, the rate limiter and offline-daemon short-circuits, and the
 * error mapping that turns a resolver timeout into a 504 rather than a
 * 500.
 */
import express, { json } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
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
const AGENT = "agent_a";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Ada's team",
    owner_id: PERSON,
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Agent;
}

function fakeSession(overrides: Partial<Session> & Pick<Session, "id">): Session {
  return {
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-04-01T10:00:00Z"),
    updated_at: new Date("2026-04-01T10:00:00Z"),
    ...overrides,
  } as Session;
}

function makeAgentRepo(agent: Agent = fakeAgent()): AgentRepository {
  return {
    findById: vi.fn(async () => agent),
    findTopLevelForOwner: vi.fn(async () => agent),
  } as unknown as AgentRepository;
}

/** The un-provisioned caller: every handler branches on this. */
function makeNoAgentRepo(): AgentRepository {
  return {
    findById: vi.fn(async () => undefined),
    findTopLevelForOwner: vi.fn(async () => undefined),
  } as unknown as AgentRepository;
}

function makePersonRepo(onboardedAt?: Date): PersonRepository {
  return {
    findById: vi.fn(async (id: string) => ({
      id,
      name: "Ada",
      email: "ada@example.com",
      ...(onboardedAt ? { onboarding_completed_at: onboardedAt } : {}),
    })),
    update: vi.fn(async () => undefined),
  } as unknown as PersonRepository;
}

function makeSessionRepo(chats: Session[] = []): SessionRepository {
  return {
    findById: vi.fn(async () => undefined),
    listChatForAgent: vi.fn(async () => chats),
    softDeleteChatChain: vi.fn(async () => chats.length),
  } as unknown as SessionRepository;
}

function makeRuntimeRepo(cli?: string): RuntimeRepository {
  return {
    findById: vi.fn(async () => (cli ? { id: "rt_1", cli } : undefined)),
  } as unknown as RuntimeRepository;
}

function makeDispatchService(result?: unknown): DispatchService {
  return {
    dispatchTask: vi.fn(async () => result),
  } as unknown as DispatchService;
}

function makeResolver(impl?: () => Promise<Session>): ChatResolver {
  return {
    register: vi.fn(impl ?? (async () => fakeSession({ id: "sess_new" }))),
  } as unknown as ChatResolver;
}

function makeHub(online = true): DaemonHub {
  return { isOnline: vi.fn(() => online) } as unknown as DaemonHub;
}

/**
 * Stand-in for `createAuthMiddleware`. The real one resolves a bv_ token
 * against Postgres; these handlers only gate on `requireHuman`, so the
 * caller source is set per-app.
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

function makeApp(overrides: Partial<ChatRoutesDeps> = {}, source: "human" | "agent" = "human") {
  const deps: ChatRoutesDeps = {
    authMiddleware: stubAuth(source),
    agentRepo: makeAgentRepo(),
    personRepo: makePersonRepo(),
    runtimeRepo: makeRuntimeRepo(),
    sessionRepo: makeSessionRepo(),
    dispatchService: makeDispatchService({
      session: fakeSession({ id: "sess_new", status: "pending" }),
      runtime_id: null,
    }),
    chatResolver: makeResolver(),
    hub: makeHub(),
    ...overrides,
  };
  const app = express();
  app.use(json());
  app.use("/", createChatRouter(deps));
  return { app, deps };
}

// `handleError` logs the stack behind a request_id; the expected-error
// tests below would otherwise spray it across the run output.
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

// ── auth gate ────────────────────────────────────────────────────────────

describe("human-only gate", () => {
  it.each([
    ["get", "/conversations"],
    ["get", "/"],
    ["post", "/"],
    ["delete", "/conversations/sess_head"],
  ] as const)("rejects an agent caller on %s %s", async (method, path) => {
    const { app } = makeApp({}, "agent");
    const res = await request(app)[method](path).send({ message: "hi" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });
});

// ── GET /conversations ───────────────────────────────────────────────────

describe("GET /conversations", () => {
  it("returns an empty list when the caller has no primary agent", async () => {
    const { app, deps } = makeApp({ agentRepo: makeNoAgentRepo() });
    const res = await request(app).get("/conversations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    // No agent means no reason to touch the session table at all.
    expect(deps.sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain with title, turn count and last activity", async () => {
    const head = fakeSession({
      id: "sess_head",
      intent: "how do I deploy?",
      result_summary: "run pnpm deploy",
      created_at: new Date("2026-04-01T10:00:00Z"),
    });
    const tail = fakeSession({
      id: "sess_tail",
      prior_session_id: "sess_head",
      intent: "and roll back?",
      result_summary: "run pnpm rollback",
      created_at: new Date("2026-04-01T10:05:00Z"),
    });
    const { app } = makeApp({ sessionRepo: makeSessionRepo([head, tail]) });
    const res = await request(app).get("/conversations");

    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head",
        title: "how do I deploy?",
        turn_count: 2,
        last_at: "2026-04-01T10:05:00.000Z",
        last_preview: "run pnpm rollback",
      },
    ]);
  });

  it("truncates a long title at CHAT_THREAD_TITLE_MAX", async () => {
    const long = "x".repeat(200);
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_head", intent: long })]),
    });
    const res = await request(app).get("/conversations");

    expect(res.body.conversations[0].title).toBe("x".repeat(79) + "…");
  });

  it("previews the error, then the intent, when there is no result_summary", async () => {
    const failed = fakeSession({
      id: "sess_a",
      status: "failed",
      intent: "deploy",
      error: "boom",
      created_at: new Date("2026-04-01T11:00:00Z"),
    });
    const pending = fakeSession({
      id: "sess_b",
      status: "pending",
      intent: "still\n  thinking",
      created_at: new Date("2026-04-01T10:00:00Z"),
    });
    const { app } = makeApp({ sessionRepo: makeSessionRepo([failed, pending]) });
    const res = await request(app).get("/conversations");

    const previews = Object.fromEntries(
      res.body.conversations.map((c: { head_id: string; last_preview: string }) => [
        c.head_id,
        c.last_preview,
      ]),
    );
    expect(previews.sess_a).toBe("boom");
    // Whitespace is collapsed so a multi-line intent stays one line.
    expect(previews.sess_b).toBe("still thinking");
  });

  it("truncates a preview past 140 chars with an ellipsis", async () => {
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([
        fakeSession({ id: "sess_a", result_summary: "y".repeat(300) }),
      ]),
    });
    const res = await request(app).get("/conversations");

    const preview: string = res.body.conversations[0].last_preview;
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("caps the list at 50 conversations, newest first", async () => {
    // 60 unrelated single-turn chains, oldest first on the way in.
    const sessions = Array.from({ length: 60 }, (_, i) =>
      fakeSession({
        id: `sess_${i}`,
        intent: `turn ${i}`,
        created_at: new Date(Date.UTC(2026, 3, 1, 0, i)),
      }),
    );
    const { app } = makeApp({ sessionRepo: makeSessionRepo(sessions) });
    const res = await request(app).get("/conversations");

    expect(res.body.conversations).toHaveLength(50);
    expect(res.body.conversations[0].head_id).toBe("sess_59");
  });
});

// ── DELETE /conversations/:headId ────────────────────────────────────────

describe("DELETE /conversations/:headId", () => {
  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.softDeleteChatChain).mockResolvedValue(3);
    const { app } = makeApp({ sessionRepo });
    const res = await request(app).delete("/conversations/sess_head");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(sessionRepo.softDeleteChatChain).toHaveBeenCalledWith("sess_head", AGENT);
  });

  it("is idempotent — a chain already deleted returns 200 with deleted: 0", async () => {
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.softDeleteChatChain).mockResolvedValue(0);
    const { app } = makeApp({ sessionRepo });
    const res = await request(app).delete("/conversations/sess_head");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("404s when the caller has no primary agent", async () => {
    const sessionRepo = makeSessionRepo();
    const { app } = makeApp({ agentRepo: makeNoAgentRepo(), sessionRepo });
    const res = await request(app).delete("/conversations/sess_head");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
    expect(sessionRepo.softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("maps a repo failure to a 500 carrying a request_id", async () => {
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.softDeleteChatChain).mockRejectedValue(new Error("pg down"));
    const { app } = makeApp({ sessionRepo });
    const res = await request(app).delete("/conversations/sess_head");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // The internal detail stays in the log, not the response body.
    expect(JSON.stringify(res.body)).not.toContain("pg down");
  });
});

// ── GET / ────────────────────────────────────────────────────────────────

describe("GET /", () => {
  it("returns a null agent and empty history when none is provisioned", async () => {
    const { app } = makeApp({ agentRepo: makeNoAgentRepo() });
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns the most recent chain when no conversation is requested", async () => {
    const older = fakeSession({
      id: "sess_old",
      intent: "old question",
      result_summary: "old answer",
      created_at: new Date("2026-04-01T09:00:00Z"),
    });
    const newer = fakeSession({
      id: "sess_new",
      intent: "new question",
      result_summary: "new answer",
      created_at: new Date("2026-04-01T10:00:00Z"),
    });
    const { app } = makeApp({ sessionRepo: makeSessionRepo([older, newer]) });
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.body.conversation_id).toBe("sess_new");
    expect(res.body.prior_session_id).toBe("sess_new");
    expect(res.body.agent).toEqual({ id: AGENT, name: "Ada's team", hierarchy: "team" });
    expect(res.body.messages).toEqual([
      { id: "u_sess_new", role: "user", content: "new question" },
      { id: "a_sess_new", role: "agent", content: "new answer", session_id: "sess_new" },
    ]);
  });

  it("renders a failed turn in history with the friendlier message", async () => {
    // The bare "CLI exited with code 1" tells the user nothing, so the
    // stderr tail on `error` wins over it.
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([
        fakeSession({
          id: "sess_a",
          intent: "deploy it",
          status: "failed",
          result_summary: "CLI exited with code 1",
          error: "claude: command not found",
        }),
      ]),
    });
    const res = await request(app).get("/");

    expect(res.body.messages).toEqual([
      { id: "u_sess_a", role: "user", content: "deploy it" },
      {
        id: "a_sess_a",
        role: "agent",
        content: "claude: command not found",
        session_id: "sess_a",
      },
    ]);
  });

  it("selects the chain named by ?c=", async () => {
    const a = fakeSession({
      id: "sess_a",
      intent: "first thread",
      created_at: new Date("2026-04-01T09:00:00Z"),
    });
    const b = fakeSession({
      id: "sess_b",
      intent: "second thread",
      created_at: new Date("2026-04-01T10:00:00Z"),
    });
    const { app } = makeApp({ sessionRepo: makeSessionRepo([a, b]) });
    const res = await request(app).get("/").query({ c: "sess_a" });

    expect(res.body.conversation_id).toBe("sess_a");
    expect(res.body.messages[0].content).toBe("first thread");
  });

  it("returns an empty history (not a 404) for an unknown ?c=", async () => {
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_a" })]),
    });
    const res = await request(app).get("/").query({ c: "sess_missing" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Ada's team", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("keeps only the newest 25 sessions of a long chain", async () => {
    // HISTORY_LIMIT is 50 messages; each session is up to 2 messages.
    const chain = Array.from({ length: 40 }, (_, i) =>
      fakeSession({
        id: `sess_${i}`,
        ...(i > 0 ? { prior_session_id: `sess_${i - 1}` } : {}),
        intent: `turn ${i}`,
        created_at: new Date(Date.UTC(2026, 3, 1, 0, i)),
      }),
    );
    const { app } = makeApp({ sessionRepo: makeSessionRepo(chain) });
    const res = await request(app).get("/");

    // 25 sessions × 1 message each (no result_summary on these).
    expect(res.body.messages).toHaveLength(25);
    expect(res.body.messages[0].content).toBe("turn 15");
    // The chain id still points at the true head, not the truncation point.
    expect(res.body.conversation_id).toBe("sess_0");
  });

  it.each(["pending", "running"])("surfaces a %s tail as in_flight_session_id", async (status) => {
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_a", status: status as never })]),
    });
    const res = await request(app).get("/");

    expect(res.body.in_flight_session_id).toBe("sess_a");
  });

  it("omits in_flight_session_id once the tail is terminal", async () => {
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_a", status: "succeeded" })]),
    });
    const res = await request(app).get("/");

    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("flags a chain pinned to a CLI the agent no longer uses", async () => {
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_a", runtime_id: "rt_1" })]),
      runtimeRepo: makeRuntimeRepo("codex"),
    });
    const res = await request(app).get("/");

    expect(res.body.runtime_mismatch).toEqual({ pinned_cli: "codex", current_cli: "claude" });
  });

  it.each([
    ["the pinned CLI matches the agent's", "claude"],
    ["the runtime row is gone", undefined],
    ["the pinned cli is unrecognized", "some-fork"],
  ])("omits runtime_mismatch when %s", async (_label, cli) => {
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_a", runtime_id: "rt_1" })]),
      runtimeRepo: makeRuntimeRepo(cli),
    });
    const res = await request(app).get("/");

    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("skips the runtime lookup entirely when the tail has no runtime_id", async () => {
    const runtimeRepo = makeRuntimeRepo("codex");
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_a" })]),
      runtimeRepo,
    });
    const res = await request(app).get("/");

    expect(res.body.runtime_mismatch).toBeUndefined();
    expect(runtimeRepo.findById).not.toHaveBeenCalled();
  });
});

// ── POST / ───────────────────────────────────────────────────────────────

describe("POST /", () => {
  it.each([
    ["an absent body field", {}],
    ["a blank string", { message: "   " }],
    ["a non-string", { message: 42 }],
  ])("400s on %s", async (_label, body) => {
    const { app, deps } = makeApp();
    const res = await request(app).post("/").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
    expect(deps.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const { app, deps } = makeApp({ agentRepo: makeNoAgentRepo() });
    const res = await request(app).post("/").send({ message: "hi" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
    expect(deps.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("dispatches a fresh turn and returns the resolved response", async () => {
    const { app, deps } = makeApp({
      chatResolver: makeResolver(async () =>
        fakeSession({ id: "sess_new", status: "succeeded", result_summary: "done!" }),
      ),
    });
    const res = await request(app).post("/").send({ message: "  hi  " });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Ada's team", hierarchy: "team" },
      session_id: "sess_new",
      response: "done!",
      status: "succeeded",
      view_refs: [],
    });
    expect(res.body.replayed).toBeUndefined();
    // The message is trimmed before dispatch, and a first turn is "fresh".
    expect(deps.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: AGENT, intent: "hi", type: "chat", reason: { kind: "fresh" } }),
    );
  });

  it("passes prior_session_id through as a chat_continuation resume", async () => {
    const { app, deps } = makeApp();
    await request(app).post("/").send({ message: "and then?", prior_session_id: "sess_prev" });

    expect(deps.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_prev" },
      }),
    );
  });

  it("forwards a well-formed client session id as the override", async () => {
    const sessionRepo = makeSessionRepo();
    const { app, deps } = makeApp({ sessionRepo });
    await request(app).post("/").send({ message: "hi", session_id: "sess_abcdef123456" });

    expect(sessionRepo.findById).toHaveBeenCalledWith("sess_abcdef123456");
    expect(deps.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: "sess_abcdef123456" }),
    );
  });

  it("ignores a malformed client session id rather than replaying on it", async () => {
    const sessionRepo = makeSessionRepo();
    const { app, deps } = makeApp({ sessionRepo });
    await request(app).post("/").send({ message: "hi", session_id: "not-a-session-id" });

    expect(sessionRepo.findById).not.toHaveBeenCalled();
    expect(deps.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: undefined }),
    );
  });

  describe("idempotent replay", () => {
    const RETRY_ID = "sess_abcdef123456";

    function appWithExisting(existing: Session | undefined) {
      const sessionRepo = makeSessionRepo();
      vi.mocked(sessionRepo.findById).mockResolvedValue(existing);
      return makeApp({ sessionRepo });
    }

    it("replays a finished turn without paying for a second dispatch", async () => {
      const { app, deps } = appWithExisting(
        fakeSession({ id: RETRY_ID, status: "succeeded", result_summary: "cached answer" }),
      );
      const res = await request(app).post("/").send({ message: "hi", session_id: RETRY_ID });

      expect(res.status).toBe(200);
      expect(res.body.replayed).toBe(true);
      expect(res.body.response).toBe("cached answer");
      expect(res.body.session_id).toBe(RETRY_ID);
      expect(deps.dispatchService.dispatchTask).not.toHaveBeenCalled();
    });

    it("replays a failed turn with the friendlier failure message", async () => {
      const { app } = appWithExisting(
        fakeSession({ id: RETRY_ID, status: "failed", error: "disk full" }),
      );
      const res = await request(app).post("/").send({ message: "hi", session_id: RETRY_ID });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ replayed: true, status: "failed", response: "disk full" });
    });

    it("409s while the prior turn is still running", async () => {
      const { app, deps } = appWithExisting(fakeSession({ id: RETRY_ID, status: "running" }));
      const res = await request(app).post("/").send({ message: "hi", session_id: RETRY_ID });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("session_in_flight");
      expect(deps.dispatchService.dispatchTask).not.toHaveBeenCalled();
    });

    it("403s when the id collides with another caller's session", async () => {
      const { app, deps } = appWithExisting(
        fakeSession({ id: RETRY_ID, agent_id: "agent_other", status: "succeeded" }),
      );
      const res = await request(app).post("/").send({ message: "hi", session_id: RETRY_ID });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("session_belongs_to_other_caller");
      expect(deps.dispatchService.dispatchTask).not.toHaveBeenCalled();
    });

    it("falls through to a real dispatch for a non-chat session id", async () => {
      const { app, deps } = appWithExisting(
        fakeSession({ id: RETRY_ID, type: "task", status: "succeeded" }),
      );
      const res = await request(app).post("/").send({ message: "hi", session_id: RETRY_ID });

      expect(res.status).toBe(200);
      expect(res.body.replayed).toBeUndefined();
      expect(deps.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
    });

    it("falls through to a real dispatch for a pending row (nothing to replay)", async () => {
      const { app, deps } = appWithExisting(fakeSession({ id: RETRY_ID, status: "pending" }));
      const res = await request(app).post("/").send({ message: "hi", session_id: RETRY_ID });

      expect(res.status).toBe(200);
      expect(deps.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
    });
  });

  describe("rate limiting", () => {
    it("429s a concurrent second turn from the same person", async () => {
      const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
      // Hold the only slot so the request below is the second in flight.
      const held = rateLimiter.acquire(PERSON);
      expect(held.ok).toBe(true);

      const { app, deps } = makeApp({ rateLimiter });
      const res = await request(app).post("/").send({ message: "hi" });

      expect(res.status).toBe(429);
      expect(res.body.error).toBe("turn_in_flight");
      expect(res.headers["retry-after"]).toBeDefined();
      expect(deps.dispatchService.dispatchTask).not.toHaveBeenCalled();
    });

    it("429s once the sliding window is full", async () => {
      const rateLimiter = new ChatRateLimiter({ maxConcurrent: 5, maxPerWindow: 1 });
      const first = rateLimiter.acquire(PERSON);
      if (first.ok) first.release();

      const { app } = makeApp({ rateLimiter });
      const res = await request(app).post("/").send({ message: "hi" });

      expect(res.status).toBe(429);
      expect(res.body.error).toBe("rate_limited");
      expect(res.body.retry_after_ms).toBeGreaterThan(0);
    });

    it("releases the slot after a turn finishes so the next one is admitted", async () => {
      const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
      const { app } = makeApp({ rateLimiter });

      expect((await request(app).post("/").send({ message: "one" })).status).toBe(200);
      expect((await request(app).post("/").send({ message: "two" })).status).toBe(200);
    });

    it("releases the slot when dispatch throws", async () => {
      const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
      const dispatchService = makeDispatchService({
        session: fakeSession({ id: "sess_new", status: "pending" }),
        runtime_id: null,
      });
      vi.mocked(dispatchService.dispatchTask).mockRejectedValueOnce(new Error("no agent"));
      const { app } = makeApp({ rateLimiter, dispatchService });

      expect((await request(app).post("/").send({ message: "one" })).status).toBe(500);
      // Slot must be free again, or one failed turn wedges the person out.
      expect((await request(app).post("/").send({ message: "two" })).status).toBe(200);
    });

    it("releases the slot when the daemon is offline", async () => {
      const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
      const dispatchService = makeDispatchService({
        session: fakeSession({ id: "sess_new", status: "pending" }),
        runtime_id: "rt_1",
      });
      const hub = makeHub(false);
      const { app } = makeApp({ rateLimiter, dispatchService, hub });

      expect((await request(app).post("/").send({ message: "one" })).status).toBe(503);
      expect((await request(app).post("/").send({ message: "two" })).status).toBe(503);
    });
  });

  it("503s when the session is bound to a daemon that is offline", async () => {
    const dispatchService = makeDispatchService({
      session: fakeSession({ id: "sess_new", status: "pending" }),
      runtime_id: "rt_1",
    });
    const { app, deps } = makeApp({ dispatchService, hub: makeHub(false) });
    const res = await request(app).post("/").send({ message: "hi" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(deps.chatResolver.register).not.toHaveBeenCalled();
  });

  it("proceeds for a null-runtime session even with no daemon online", async () => {
    // runtime_id null routes to the in-process executor, so hub state is
    // irrelevant — checking it would 503 every legacy agent.
    const hub = makeHub(false);
    const { app, deps } = makeApp({ hub });
    const res = await request(app).post("/").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(hub.isOnline).not.toHaveBeenCalled();
    expect(deps.chatResolver.register).toHaveBeenCalledWith("sess_new", 90_000);
  });

  it("500s when dispatch throws", async () => {
    const dispatchService = makeDispatchService();
    vi.mocked(dispatchService.dispatchTask).mockRejectedValue(new Error("agent not found"));
    const { app, deps } = makeApp({ dispatchService });
    const res = await request(app).post("/").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(deps.chatResolver.register).not.toHaveBeenCalled();
  });

  it("504s when the resolver times out", async () => {
    const { app } = makeApp({
      chatResolver: makeResolver(async () => {
        throw new Error("chat resolver timeout (90000ms) for sess_new");
      }),
    });
    const res = await request(app).post("/").send({ message: "hi" });

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ error: "chat_turn_timeout", timeout_ms: 90_000 });
  });

  it("500s on a non-timeout resolver failure", async () => {
    const { app } = makeApp({
      chatResolver: makeResolver(async () => {
        throw new Error("chat resolver already registered for sess_new");
      }),
    });
    const res = await request(app).post("/").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });

  describe("onboarding flip", () => {
    it("stamps onboarding_completed_at on the first successful turn", async () => {
      const personRepo = makePersonRepo(); // no onboarding_completed_at
      const { app } = makeApp({ personRepo });
      const res = await request(app).post("/").send({ message: "hi" });

      expect(res.status).toBe(200);
      expect(personRepo.update).toHaveBeenCalledWith(PERSON, {
        onboarding_completed_at: expect.any(Date),
      });
    });

    it("leaves an already-onboarded person alone", async () => {
      const personRepo = makePersonRepo(new Date("2026-01-01"));
      const { app } = makeApp({ personRepo });
      await request(app).post("/").send({ message: "hi" });

      expect(personRepo.update).not.toHaveBeenCalled();
    });

    it("does not flip onboarding on a failed turn", async () => {
      const personRepo = makePersonRepo();
      const { app } = makeApp({
        personRepo,
        chatResolver: makeResolver(async () =>
          fakeSession({ id: "sess_new", status: "failed", error: "boom" }),
        ),
      });
      const res = await request(app).post("/").send({ message: "hi" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("failed");
      expect(personRepo.update).not.toHaveBeenCalled();
    });

    it("still answers the turn when the onboarding write rejects", async () => {
      // Fire-and-forget by design — a flaky write must not fail the turn.
      const personRepo = makePersonRepo();
      vi.mocked(personRepo.update).mockRejectedValue(new Error("pg down"));
      const { app } = makeApp({ personRepo });
      const res = await request(app).post("/").send({ message: "hi" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
