/**
 * /chat router handlers — unit tests with vitest fakes (no DB, no CLI).
 *
 * `chat-internals.test.ts` covers the pure helpers this module exports
 * (groupIntoConversations, failureMessageFor, chainToMessages). This
 * file covers the four handlers around them, where the risk is money
 * and correctness rather than formatting:
 *
 *   - POST /chat spawns a real CLI subprocess per turn, so the
 *     idempotent-replay path (`session_id` → persisted result) and the
 *     rate limiter are budget guards. Both are pinned here, including
 *     the `release()` on every early return — a leaked in-flight slot
 *     would wedge the caller's next turn behind a 429 forever.
 *   - The 503 agent-offline shortcut exists so a stopped daemon fails
 *     fast instead of burning the 90s resolver timeout.
 *   - GET /chat reconstructs the thread the web client rehydrates from,
 *     including the runtime-pin mismatch banner and the in-flight id
 *     that restores the "thinking" indicator after a navigation.
 *   - DELETE scopes the soft-delete to the caller's own primary agent.
 */
import express, { json, type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import type { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { createChatRouter } from "./chat.js";

const PERSON = "person_1";
const AGENT = "agent_a";

// ── fakes ────────────────────────────────────────────────────────────────

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
  };
}

function fakePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: PERSON,
    name: "Ada",
    email: "ada@example.com",
    capability_network_enabled: true,
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  };
}

function fakeSession(overrides: Partial<Session> & Pick<Session, "id">): Session {
  return {
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-05-01T10:00:00Z"),
    ...overrides,
  } as Session;
}

/**
 * `agent: null` means "no primary agent provisioned" — distinct from
 * omitting the argument, which gives the default agent. A default
 * parameter would collapse the two, since an explicit `undefined`
 * triggers it.
 */
function makeAgentRepo(agent: Agent | null = fakeAgent()): AgentRepository {
  const row = agent ?? undefined;
  return {
    findById: vi.fn(async () => row),
    findTopLevelForOwner: vi.fn(async () => row),
    findByApiKey: vi.fn(),
    findSubordinates: vi.fn(async () => []),
    findPeers: vi.fn(async () => []),
    findParent: vi.fn(),
    findByLevel: vi.fn(async () => []),
    findDescendantIds: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as AgentRepository;
}

function makePersonRepo(person: Person | null = fakePerson()): PersonRepository {
  const row = person ?? undefined;
  return {
    findById: vi.fn(async () => row),
    findByEmail: vi.fn(),
    findByApiKey: vi.fn(),
    findManyByIds: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(async () => row as Person),
    delete: vi.fn(),
  } as unknown as PersonRepository;
}

function makeSessionRepo(
  opts: {
    chats?: Session[];
    findById?: Session | undefined;
    softDeleted?: number;
  } = {},
): SessionRepository {
  return {
    findById: vi.fn(async () => opts.findById),
    listChatForAgent: vi.fn(async () => opts.chats ?? []),
    softDeleteChatChain: vi.fn(async () => opts.softDeleted ?? 0),
  } as unknown as SessionRepository;
}

function makeRuntimeRepo(runtime: Runtime | null = null): RuntimeRepository {
  return {
    findById: vi.fn(async () => runtime ?? undefined),
  } as unknown as RuntimeRepository;
}

function makeDispatch(
  result: { session: { id: string }; runtime_id: string | null } = {
    session: { id: "sess_dispatched1" },
    runtime_id: null,
  },
): DispatchService {
  return {
    dispatchTask: vi.fn(async () => result),
  } as unknown as DispatchService;
}

function makeResolver(impl?: () => Promise<Session>): ChatResolver {
  return {
    register: vi.fn(
      impl ?? (async () => fakeSession({ id: "sess_dispatched1", result_summary: "hi" })),
    ),
  } as unknown as ChatResolver;
}

function makeHub(online = true): DaemonHub {
  return { isOnline: vi.fn(() => online) } as unknown as DaemonHub;
}

function stubAuth(source: "human" | "agent" | "none" = "human") {
  return (req: Request, _res: Response, next: NextFunction) => {
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

interface AppOpts {
  agentRepo?: AgentRepository;
  personRepo?: PersonRepository;
  sessionRepo?: SessionRepository;
  runtimeRepo?: RuntimeRepository;
  dispatchService?: DispatchService;
  chatResolver?: ChatResolver;
  hub?: DaemonHub;
  rateLimiter?: ChatRateLimiter;
  source?: "human" | "agent" | "none";
}

function makeApp(opts: AppOpts = {}) {
  const deps = {
    authMiddleware: stubAuth(opts.source ?? "human"),
    agentRepo: opts.agentRepo ?? makeAgentRepo(),
    personRepo: opts.personRepo ?? makePersonRepo(),
    runtimeRepo: opts.runtimeRepo ?? makeRuntimeRepo(),
    sessionRepo: opts.sessionRepo ?? makeSessionRepo(),
    dispatchService: opts.dispatchService ?? makeDispatch(),
    chatResolver: opts.chatResolver ?? makeResolver(),
    hub: opts.hub ?? makeHub(),
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
  };
  const app = express();
  app.use(json());
  app.use("/chat", createChatRouter(deps));
  return { app, ...deps };
}

// The 500 path logs the stack by design; keep the suite output readable.
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

// ── auth gate ────────────────────────────────────────────────────────────

describe("/chat human-only gate", () => {
  it.each([
    ["GET", "/chat"],
    ["GET", "/chat/conversations"],
    ["POST", "/chat"],
    ["DELETE", "/chat/conversations/sess_head"],
  ])("403s %s %s for an agent token", async (method, path) => {
    const { app } = makeApp({ source: "agent" });
    const agent = request(app);
    const verb = method.toLowerCase() as "get" | "post" | "delete";
    const res = await agent[verb](path).send({ message: "hi" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "human_required" });
  });

  it("403s an unauthenticated caller", async () => {
    const { app } = makeApp({ source: "none" });
    const res = await request(app).get("/chat");
    expect(res.status).toBe(403);
  });
});

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /chat/conversations", () => {
  it("returns an empty list when the caller has no primary agent", async () => {
    const { app, sessionRepo } = makeApp({ agentRepo: makeAgentRepo(null) });

    const res = await request(app).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain with its head title, turn count and last preview", async () => {
    const chats = [
      fakeSession({
        id: "sess_head00001",
        intent: "set up CI",
        created_at: new Date("2026-05-01T10:00:00Z"),
        result_summary: "first reply",
      }),
      fakeSession({
        id: "sess_tail00001",
        prior_session_id: "sess_head00001",
        intent: "now add lint",
        created_at: new Date("2026-05-01T10:05:00Z"),
        result_summary: "lint added",
      }),
    ];
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head00001",
        title: "set up CI",
        turn_count: 2,
        last_at: "2026-05-01T10:05:00.000Z",
        last_preview: "lint added",
      },
    ]);
  });

  it("truncates a long head intent to the thread-title ceiling", async () => {
    const chats = [fakeSession({ id: "sess_a", intent: "x".repeat(200) })];
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat/conversations");

    const title: string = res.body.conversations[0].title;
    expect(title).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("previews the error when a failed tail has no result_summary", async () => {
    const chats = [
      fakeSession({ id: "sess_a", status: "failed", error: "CLI exited with code 1" }),
    ];
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat/conversations");

    expect(res.body.conversations[0].last_preview).toBe("CLI exited with code 1");
  });

  it("falls back to the intent when a tail has neither summary nor error", async () => {
    const chats = [fakeSession({ id: "sess_a", status: "pending", intent: "do a thing" })];
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat/conversations");

    expect(res.body.conversations[0].last_preview).toBe("do a thing");
  });

  it("collapses whitespace and ellipsizes a long preview", async () => {
    const chats = [
      fakeSession({ id: "sess_a", result_summary: `line one\n\nline  two ${"y".repeat(200)}` }),
    ];
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat/conversations");

    const preview: string = res.body.conversations[0].last_preview;
    expect(preview).toHaveLength(140);
    expect(preview.startsWith("line one line two")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("caps the response at 50 conversations even when more chains exist", async () => {
    const chats = Array.from({ length: 60 }, (_, i) =>
      fakeSession({
        id: `sess_${String(i).padStart(9, "0")}`,
        created_at: new Date(2026, 4, 1, 10, i),
      }),
    );
    const { app, sessionRepo } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat/conversations");

    expect(res.body.conversations).toHaveLength(50);
    // And the DB read itself is bounded rather than unlimited.
    expect(sessionRepo.listChatForAgent).toHaveBeenCalledWith(AGENT, 400);
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /chat/conversations/:headId", () => {
  it("soft-deletes the chain scoped to the caller's own agent", async () => {
    const sessionRepo = makeSessionRepo({ softDeleted: 3 });
    const { app } = makeApp({ sessionRepo });

    const res = await request(app).delete("/chat/conversations/sess_head00001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(sessionRepo.softDeleteChatChain).toHaveBeenCalledWith("sess_head00001", AGENT);
  });

  it("is idempotent — a re-delete returns ok with deleted: 0", async () => {
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ softDeleted: 0 }) });

    const res = await request(app).delete("/chat/conversations/sess_head00001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("404s when the caller has no primary agent", async () => {
    const sessionRepo = makeSessionRepo();
    const { app } = makeApp({ agentRepo: makeAgentRepo(null), sessionRepo });

    const res = await request(app).delete("/chat/conversations/sess_head00001");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "agent_not_found" });
    expect(sessionRepo.softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("500s with a request_id when the repo throws, without leaking the message", async () => {
    const sessionRepo = makeSessionRepo();
    sessionRepo.softDeleteChatChain = vi.fn(async () => {
      throw new Error("deadlock detected on session_pkey");
    });
    const { app } = makeApp({ sessionRepo });

    const res = await request(app).delete("/chat/conversations/sess_head00001");

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "internal_error" });
    expect(String(res.body.request_id)).toMatch(/^req_/);
    expect(JSON.stringify(res.body)).not.toContain("deadlock");
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /chat", () => {
  it("returns a null agent and an empty thread when none is provisioned", async () => {
    const { app } = makeApp({ agentRepo: makeAgentRepo(null) });

    const res = await request(app).get("/chat");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns the agent with an empty thread when there are no chat sessions", async () => {
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats: [] }) });

    const res = await request(app).get("/chat");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Ada's team", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns the most recent chain by default, with user + agent bubbles", async () => {
    const chats = [
      fakeSession({
        id: "sess_old000001",
        intent: "old thread",
        created_at: new Date("2026-05-01T09:00:00Z"),
        result_summary: "old reply",
      }),
      fakeSession({
        id: "sess_new000001",
        intent: "new thread",
        created_at: new Date("2026-05-01T11:00:00Z"),
        result_summary: "new reply",
      }),
    ];
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat");

    expect(res.body.conversation_id).toBe("sess_new000001");
    expect(res.body.prior_session_id).toBe("sess_new000001");
    expect(res.body.messages).toEqual([
      { id: "u_sess_new000001", role: "user", content: "new thread" },
      {
        id: "a_sess_new000001",
        role: "agent",
        content: "new reply",
        session_id: "sess_new000001",
      },
    ]);
  });

  it("returns the requested chain when ?c= names a head", async () => {
    const chats = [
      fakeSession({
        id: "sess_old000001",
        intent: "old thread",
        created_at: new Date("2026-05-01T09:00:00Z"),
        result_summary: "old reply",
      }),
      fakeSession({
        id: "sess_new000001",
        intent: "new thread",
        created_at: new Date("2026-05-01T11:00:00Z"),
        result_summary: "new reply",
      }),
    ];
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat?c=sess_old000001");

    expect(res.body.conversation_id).toBe("sess_old000001");
    expect(res.body.messages[0]).toMatchObject({ content: "old thread" });
  });

  it("returns an empty thread (not 404) when ?c= names an unknown head", async () => {
    const chats = [fakeSession({ id: "sess_a", result_summary: "hi" })];
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat?c=sess_nope");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      messages: [],
      prior_session_id: null,
      conversation_id: null,
      agent: { id: AGENT },
    });
  });

  it("ignores a repeated ?c= (array) query and falls back to the newest chain", async () => {
    const chats = [fakeSession({ id: "sess_a", intent: "only", result_summary: "hi" })];
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat?c=sess_a&c=sess_b");

    expect(res.body.conversation_id).toBe("sess_a");
  });

  it("truncates a long chain to the history limit, keeping the newest turns", async () => {
    const chats = Array.from({ length: 40 }, (_, i) =>
      fakeSession({
        id: `sess_t${String(i).padStart(8, "0")}`,
        ...(i > 0 ? { prior_session_id: `sess_t${String(i - 1).padStart(8, "0")}` } : {}),
        intent: `turn ${i}`,
        result_summary: `reply ${i}`,
        created_at: new Date(2026, 4, 1, 10, i),
      }),
    );
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat");

    // 25 sessions kept (ceil(50/2)) × 2 messages each.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0]).toMatchObject({ content: "turn 15" });
    expect(res.body.conversation_id).toBe("sess_t00000000");
    expect(res.body.prior_session_id).toBe("sess_t00000039");
  });

  it.each(["pending", "running"])(
    "surfaces in_flight_session_id when the tail is %s",
    async (status) => {
      const chats = [
        fakeSession({ id: "sess_a", status: status as Session["status"], intent: "working" }),
      ];
      const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

      const res = await request(app).get("/chat");

      expect(res.body.in_flight_session_id).toBe("sess_a");
    },
  );

  it("omits in_flight_session_id once the tail has settled", async () => {
    const chats = [fakeSession({ id: "sess_a", status: "succeeded", result_summary: "done" })];
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ chats }) });

    const res = await request(app).get("/chat");

    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  describe("runtime pin mismatch", () => {
    const chats = [
      fakeSession({ id: "sess_a", runtime_id: "rt_1", result_summary: "hi" }),
    ];

    it("flags a chain pinned to a different CLI than the agent now runs", async () => {
      const { app } = makeApp({
        sessionRepo: makeSessionRepo({ chats }),
        runtimeRepo: makeRuntimeRepo({ id: "rt_1", cli: "codex" } as Runtime),
        agentRepo: makeAgentRepo(fakeAgent({ runtime_config: { type: "claude" } })),
      });

      const res = await request(app).get("/chat");

      expect(res.body.runtime_mismatch).toEqual({
        pinned_cli: "codex",
        current_cli: "claude",
      });
    });

    it("omits the flag when the pinned CLI matches the current one", async () => {
      const { app } = makeApp({
        sessionRepo: makeSessionRepo({ chats }),
        runtimeRepo: makeRuntimeRepo({ id: "rt_1", cli: "claude" } as Runtime),
      });

      const res = await request(app).get("/chat");

      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it("omits the flag when the tail session has no runtime_id", async () => {
      const runtimeRepo = makeRuntimeRepo({ id: "rt_1", cli: "codex" } as Runtime);
      const { app } = makeApp({
        sessionRepo: makeSessionRepo({
          chats: [fakeSession({ id: "sess_a", result_summary: "hi" })],
        }),
        runtimeRepo,
      });

      const res = await request(app).get("/chat");

      expect(res.body.runtime_mismatch).toBeUndefined();
      expect(runtimeRepo.findById).not.toHaveBeenCalled();
    });

    it("omits the flag when the pinned runtime row is gone", async () => {
      const { app } = makeApp({
        sessionRepo: makeSessionRepo({ chats }),
        runtimeRepo: makeRuntimeRepo(null),
      });

      const res = await request(app).get("/chat");

      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it("omits the flag when the pinned runtime's cli isn't a known CLI", async () => {
      const { app } = makeApp({
        sessionRepo: makeSessionRepo({ chats }),
        runtimeRepo: makeRuntimeRepo({ id: "rt_1", cli: "ancient-cli" } as Runtime),
      });

      const res = await request(app).get("/chat");

      expect(res.body.runtime_mismatch).toBeUndefined();
    });
  });
});

// ── POST /chat ───────────────────────────────────────────────────────────

describe("POST /chat validation", () => {
  it.each([
    ["an empty body", {}],
    ["a blank message", { message: "   " }],
    ["a non-string message", { message: 42 }],
  ])("400s on %s without dispatching", async (_label, body) => {
    const dispatchService = makeDispatch();
    const { app } = makeApp({ dispatchService });

    const res = await request(app).post("/chat").send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "message_required" });
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const dispatchService = makeDispatch();
    const { app } = makeApp({ agentRepo: makeAgentRepo(null), dispatchService });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "no_primary_agent" });
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });
});

describe("POST /chat dispatch", () => {
  it("dispatches a fresh chat turn and returns the resolver's result", async () => {
    const dispatchService = makeDispatch();
    const chatResolver = makeResolver(async () =>
      fakeSession({ id: "sess_dispatched1", result_summary: "the answer is 42" }),
    );
    const { app } = makeApp({ dispatchService, chatResolver });

    const res = await request(app).post("/chat").send({ message: "  what is 6*7?  " });

    expect(res.status).toBe(200);
    expect(dispatchService.dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      intent: "what is 6*7?",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Ada's team", hierarchy: "team" },
      session_id: "sess_dispatched1",
      response: "the answer is 42",
      status: "succeeded",
      view_refs: [],
    });
  });

  it("sends prior_session_id through as a chat_continuation resume reason", async () => {
    const dispatchService = makeDispatch();
    const { app } = makeApp({ dispatchService });

    await request(app)
      .post("/chat")
      .send({ message: "and in hex?", prior_session_id: "sess_prior0001" });

    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_prior0001" },
      }),
    );
  });

  it("honours a well-formed client session_id as the dispatch override", async () => {
    const dispatchService = makeDispatch({
      session: { id: "sess_Abc123XYZ789" },
      runtime_id: null,
    });
    const { app } = makeApp({
      dispatchService,
      sessionRepo: makeSessionRepo({ findById: undefined }),
    });

    await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_Abc123XYZ789" });

    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: "sess_Abc123XYZ789" }),
    );
  });

  it.each([
    ["the wrong prefix", "task_Abc123XYZ789"],
    ["too short", "sess_Abc123"],
    ["punctuation", "sess_Abc123XYZ-8"],
  ])("ignores a client session_id with %s", async (_label, sessionId) => {
    const dispatchService = makeDispatch();
    const sessionRepo = makeSessionRepo();
    const { app } = makeApp({ dispatchService, sessionRepo });

    await request(app).post("/chat").send({ message: "hi", session_id: sessionId });

    expect(sessionRepo.findById).not.toHaveBeenCalled();
    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: undefined }),
    );
  });

  it("rewrites the daemon's runtime-missing throw into something the user can act on", async () => {
    const raw = "No runtime registered for dispatch payload type 'codex'";
    const chatResolver = makeResolver(async () =>
      fakeSession({ id: "sess_dispatched1", status: "failed", error: raw }),
    );
    const { app } = makeApp({ chatResolver });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.response).not.toBe(raw);
    expect(res.body.response).toContain("codex");
    expect(res.body.response).toContain("beevibe-daemon sync");
  });

  it("replaces a bare CLI-exit failure with the daemon-log pointer", async () => {
    const chatResolver = makeResolver(async () =>
      fakeSession({
        id: "sess_dispatched1",
        status: "failed",
        error: "CLI exited with code 1",
      }),
    );
    const { app } = makeApp({ chatResolver });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.body.status).toBe("failed");
    expect(res.body.response).not.toBe("CLI exited with code 1");
    expect(res.body.response.length).toBeGreaterThan(0);
  });

  it("passes an informative failure through verbatim", async () => {
    const chatResolver = makeResolver(async () =>
      fakeSession({
        id: "sess_dispatched1",
        status: "failed",
        error: "workspace provisioning failed: EACCES",
      }),
    );
    const { app } = makeApp({ chatResolver });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.body.response).toBe("workspace provisioning failed: EACCES");
  });

  it("503s fast when the dispatch bound a runtime whose daemon is offline", async () => {
    const dispatchService = makeDispatch({
      session: { id: "sess_dispatched1" },
      runtime_id: "rt_1",
    });
    const chatResolver = makeResolver();
    const { app } = makeApp({ dispatchService, chatResolver, hub: makeHub(false) });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "agent_offline" });
    // Never registers a resolver — that's the point of failing fast.
    expect(chatResolver.register).not.toHaveBeenCalled();
  });

  it("proceeds when runtime_id is null (in-process executor fallback)", async () => {
    const chatResolver = makeResolver();
    const hub = makeHub(false);
    const { app } = makeApp({
      dispatchService: makeDispatch({ session: { id: "sess_dispatched1" }, runtime_id: null }),
      chatResolver,
      hub,
    });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(hub.isOnline).not.toHaveBeenCalled();
    expect(chatResolver.register).toHaveBeenCalled();
  });

  it("500s when dispatch itself throws", async () => {
    const dispatchService = {
      dispatchTask: vi.fn(async () => {
        throw new Error("agent has no runtime_config");
      }),
    } as unknown as DispatchService;
    const { app } = makeApp({ dispatchService });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "internal_error" });
  });

  it("504s when the resolver times out", async () => {
    const chatResolver = makeResolver(async () => {
      throw new Error("chat resolver timeout (90000ms) for sess_dispatched1");
    });
    const { app } = makeApp({ chatResolver });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ error: "chat_turn_timeout", timeout_ms: 90_000 });
  });

  it("500s when the resolver rejects for a non-timeout reason", async () => {
    const chatResolver = makeResolver(async () => {
      throw new Error("chat resolver already registered for sess_dispatched1");
    });
    const { app } = makeApp({ chatResolver });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "internal_error" });
  });
});

describe("POST /chat onboarding flip", () => {
  it("stamps onboarding_completed_at on the first succeeded turn", async () => {
    const personRepo = makePersonRepo(fakePerson({ onboarding_completed_at: undefined }));
    const { app } = makeApp({ personRepo });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(personRepo.update).toHaveBeenCalledWith(
      PERSON,
      expect.objectContaining({ onboarding_completed_at: expect.any(Date) }),
    );
  });

  it("does not re-stamp a person who already onboarded", async () => {
    const personRepo = makePersonRepo(
      fakePerson({ onboarding_completed_at: new Date("2026-04-02") }),
    );
    const { app } = makeApp({ personRepo });

    await request(app).post("/chat").send({ message: "hi" });

    expect(personRepo.update).not.toHaveBeenCalled();
  });

  it("does not stamp when the first turn failed", async () => {
    const personRepo = makePersonRepo(fakePerson({ onboarding_completed_at: undefined }));
    const chatResolver = makeResolver(async () =>
      fakeSession({ id: "sess_dispatched1", status: "failed", error: "boom" }),
    );
    const { app } = makeApp({ personRepo, chatResolver });

    await request(app).post("/chat").send({ message: "hi" });

    expect(personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers the turn when the flip write rejects (fire-and-forget)", async () => {
    const personRepo = makePersonRepo(fakePerson({ onboarding_completed_at: undefined }));
    personRepo.update = vi.fn(async () => {
      throw new Error("person row locked");
    }) as unknown as PersonRepository["update"];
    const { app } = makeApp({ personRepo });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("POST /chat idempotent replay", () => {
  const CLIENT_SID = "sess_Abc123XYZ789";

  it("replays a succeeded session instead of spawning another turn", async () => {
    const dispatchService = makeDispatch();
    const existing = fakeSession({
      id: CLIENT_SID,
      status: "succeeded",
      result_summary: "cached answer",
    });
    const { app } = makeApp({
      dispatchService,
      sessionRepo: makeSessionRepo({ findById: existing }),
    });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      replayed: true,
      session_id: CLIENT_SID,
      response: "cached answer",
      status: "succeeded",
    });
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed session with the friendly failure message", async () => {
    const existing = fakeSession({
      id: CLIENT_SID,
      status: "failed",
      error: "CLI exited with code 1",
    });
    const { app } = makeApp({ sessionRepo: makeSessionRepo({ findById: existing }) });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replayed: true, status: "failed" });
  });

  it("409s while the prior turn on that id is still running", async () => {
    const dispatchService = makeDispatch();
    const existing = fakeSession({ id: CLIENT_SID, status: "running" });
    const { app } = makeApp({
      dispatchService,
      sessionRepo: makeSessionRepo({ findById: existing }),
    });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "session_in_flight" });
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the id collides with another caller's session", async () => {
    const dispatchService = makeDispatch();
    const existing = fakeSession({ id: CLIENT_SID, agent_id: "agent_someone_else" });
    const { app } = makeApp({
      dispatchService,
      sessionRepo: makeSessionRepo({ findById: existing }),
    });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "session_belongs_to_other_caller" });
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("falls through to a live turn when the id is unknown", async () => {
    const dispatchService = makeDispatch({
      session: { id: CLIENT_SID },
      runtime_id: null,
    });
    const { app } = makeApp({
      dispatchService,
      sessionRepo: makeSessionRepo({ findById: undefined }),
    });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBeUndefined();
    expect(dispatchService.dispatchTask).toHaveBeenCalled();
  });

  it("falls through when the row exists but isn't a chat session", async () => {
    const dispatchService = makeDispatch({
      session: { id: CLIENT_SID },
      runtime_id: null,
    });
    const existing = fakeSession({ id: CLIENT_SID, type: "task", status: "succeeded" });
    const { app } = makeApp({
      dispatchService,
      sessionRepo: makeSessionRepo({ findById: existing }),
    });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(200);
    expect(dispatchService.dispatchTask).toHaveBeenCalled();
  });

  it("falls through to a live turn when the prior attempt is still pending", async () => {
    const dispatchService = makeDispatch({
      session: { id: CLIENT_SID },
      runtime_id: null,
    });
    const existing = fakeSession({ id: CLIENT_SID, status: "pending" });
    const { app } = makeApp({
      dispatchService,
      sessionRepo: makeSessionRepo({ findById: existing }),
    });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(200);
    expect(dispatchService.dispatchTask).toHaveBeenCalled();
  });
});

describe("POST /chat rate limiting", () => {
  it("429s with turn_in_flight when a concurrent turn holds the slot", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    limiter.acquire(PERSON); // occupy the slot and never release
    const dispatchService = makeDispatch();
    const { app } = makeApp({ rateLimiter: limiter, dispatchService });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "turn_in_flight" });
    expect(res.headers["retry-after"]).toBeDefined();
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("429s with rate_limited once the sliding window is full", async () => {
    let now = 1_000_000;
    const limiter = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 2,
      windowMs: 60_000,
      now: () => now,
    });
    const { app } = makeApp({ rateLimiter: limiter });

    expect((await request(app).post("/chat").send({ message: "a" })).status).toBe(200);
    expect((await request(app).post("/chat").send({ message: "b" })).status).toBe(200);

    const res = await request(app).post("/chat").send({ message: "c" });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "rate_limited" });

    // The window is a window, not a ban — it reopens once it slides past.
    now += 60_001;
    expect((await request(app).post("/chat").send({ message: "d" })).status).toBe(200);
  });

  it("releases the slot after a successful turn so the next one goes through", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 10 });
    const { app } = makeApp({ rateLimiter: limiter });

    expect((await request(app).post("/chat").send({ message: "a" })).status).toBe(200);
    expect((await request(app).post("/chat").send({ message: "b" })).status).toBe(200);
  });

  it.each([
    [
      "a dispatch throw",
      {
        dispatchService: {
          dispatchTask: vi.fn(async () => {
            throw new Error("nope");
          }),
        } as unknown as DispatchService,
      },
      500,
    ],
    [
      "a 503 offline short-circuit",
      {
        dispatchService: makeDispatch({
          session: { id: "sess_dispatched1" },
          runtime_id: "rt_1",
        }),
        hub: makeHub(false),
      },
      503,
    ],
    [
      "a resolver timeout",
      {
        chatResolver: makeResolver(async () => {
          throw new Error("chat resolver timeout (90000ms)");
        }),
      },
      504,
    ],
  ])("releases the slot after %s", async (_label, overrides, expectedStatus) => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 10 });
    const { app } = makeApp({ rateLimiter: limiter, ...(overrides as AppOpts) });

    const first = await request(app).post("/chat").send({ message: "a" });
    expect(first.status).toBe(expectedStatus);

    // If the slot leaked, this would be a 429 rather than the same error.
    const second = await request(app).post("/chat").send({ message: "b" });
    expect(second.status).toBe(expectedStatus);
  });

  it("does not consume a slot on a replayed turn", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 1 });
    const existing = fakeSession({
      id: "sess_Abc123XYZ789",
      status: "succeeded",
      result_summary: "cached",
    });
    const { app } = makeApp({
      rateLimiter: limiter,
      sessionRepo: makeSessionRepo({ findById: existing }),
    });

    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post("/chat")
        .send({ message: "hi", session_id: "sess_Abc123XYZ789" });
      expect(res.status).toBe(200);
      expect(res.body.replayed).toBe(true);
    }
  });

  it("defaults to a real limiter when none is injected", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
  });
});
