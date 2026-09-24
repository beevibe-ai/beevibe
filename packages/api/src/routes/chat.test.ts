/**
 * /chat REST surface — unit tests with vitest fakes (no DB).
 *
 * `chat-internals.test.ts` already pins the pure helpers
 * (groupIntoConversations, chainToMessages, failureMessageFor). This
 * file covers the four handlers `createChatRouter` mounts, which carry
 * the branchy parts nothing else exercises:
 *
 *   - GET /conversations — chain → row projection (title truncation,
 *     turn_count, preview built off the *last* turn).
 *   - DELETE /conversations/:headId — agent scoping and the generic
 *     500 envelope.
 *   - GET / — conversation selection (`?c=`), the in-flight tail id the
 *     chat UI resumes its spinner from, and the runtime-mismatch probe.
 *   - POST / — the expensive one. Validation, the idempotent replay
 *     ladder (403/409/200-replayed), rate limiting, the daemon-offline
 *     503, the 504 timeout, and the fire-and-forget onboarding flip.
 */
import express, { json } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
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
import { createChatRouter, type ChatRoutesDeps } from "./chat.js";

const PERSON = "person_1";
const AGENT = "agent_a";

// ── Fixtures ─────────────────────────────────────────────────────────────

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
    updated_at: new Date("2026-05-01T10:00:00Z"),
    ...overrides,
  } as Session;
}

// ── Fakes ────────────────────────────────────────────────────────────────

/** `null` models "no primary agent provisioned for this person". */
function makeAgentRepo(agent: Agent | null = fakeAgent()): AgentRepository {
  return {
    findTopLevelForOwner: vi.fn(async () => agent ?? undefined),
    findById: vi.fn(async () => agent ?? undefined),
  } as unknown as AgentRepository;
}

function makePersonRepo(person: Person | null = fakePerson()): PersonRepository {
  return {
    findById: vi.fn(async () => person ?? undefined),
    update: vi.fn(async () => person as Person),
  } as unknown as PersonRepository;
}

function makeSessionRepo(chats: Session[] = []): SessionRepository {
  return {
    listChatForAgent: vi.fn(async () => chats),
    softDeleteChatChain: vi.fn(async () => chats.length),
    findById: vi.fn(async () => undefined),
  } as unknown as SessionRepository;
}

function makeRuntimeRepo(runtime?: Runtime): RuntimeRepository {
  return {
    findById: vi.fn(async () => runtime),
  } as unknown as RuntimeRepository;
}

function makeDispatch(result: { session: Session; runtime_id: string | null }): DispatchService {
  return { dispatchTask: vi.fn(async () => result) } as unknown as DispatchService;
}

function makeResolver(impl: () => Promise<Session>): ChatResolver {
  return { register: vi.fn(impl) } as unknown as ChatResolver;
}

function makeHub(online = true): DaemonHub {
  return { isOnline: vi.fn(() => online) } as unknown as DaemonHub;
}

function stubAuth(source: "human" | "agent" | "none" = "human") {
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

type Overrides = Partial<Omit<ChatRoutesDeps, "authMiddleware">>;

function makeApp(overrides: Overrides = {}, source: "human" | "agent" | "none" = "human") {
  const deps: ChatRoutesDeps = {
    authMiddleware: stubAuth(source),
    agentRepo: makeAgentRepo(),
    personRepo: makePersonRepo(),
    runtimeRepo: makeRuntimeRepo(),
    sessionRepo: makeSessionRepo(),
    dispatchService: makeDispatch({
      session: fakeSession({ id: "sess_new" }),
      runtime_id: null,
    }),
    chatResolver: makeResolver(async () => fakeSession({ id: "sess_new" })),
    hub: makeHub(),
    ...overrides,
  };
  const app = express();
  app.use(json());
  app.use("/chat", createChatRouter(deps));
  return { app, deps };
}

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /chat/conversations", () => {
  it("403s a non-human caller", async () => {
    const { app } = makeApp({}, "agent");
    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const sessionRepo = makeSessionRepo();
    const { app } = makeApp({ agentRepo: makeAgentRepo(null), sessionRepo });
    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    // Short-circuits before touching the session store.
    expect(sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("projects each chain into a row keyed off head + last turn", async () => {
    const head = fakeSession({
      id: "sess_head",
      intent: "plan the migration",
      created_at: new Date("2026-05-01T10:00:00Z"),
    });
    const tail = fakeSession({
      id: "sess_tail",
      prior_session_id: "sess_head",
      intent: "and the rollback?",
      result_summary: "Rollback   is\na one-liner.",
      created_at: new Date("2026-05-01T10:05:00Z"),
    });
    const { app } = makeApp({ sessionRepo: makeSessionRepo([tail, head]) });

    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head",
        // Title comes from the head turn's intent...
        title: "plan the migration",
        turn_count: 2,
        last_at: "2026-05-01T10:05:00.000Z",
        // ...the preview from the last turn's summary, whitespace-collapsed.
        last_preview: "Rollback is a one-liner.",
      },
    ]);
  });

  it("truncates a long head intent into the thread title", async () => {
    const intent = "x".repeat(200);
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_head", intent })]),
    });
    const res = await request(app).get("/chat/conversations");
    expect(res.body.conversations[0].title.length).toBeLessThanOrEqual(80);
    expect(res.body.conversations[0].title).not.toEqual(intent);
  });

  it("elides a preview past the 140-char budget", async () => {
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([
        fakeSession({ id: "sess_head", result_summary: "y".repeat(300) }),
      ]),
    });
    const res = await request(app).get("/chat/conversations");
    const preview: string = res.body.conversations[0].last_preview;
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("falls back to the error, then the intent, when there's no summary", async () => {
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([
        fakeSession({
          id: "sess_a",
          intent: "a",
          error: "boom",
          created_at: new Date("2026-05-01T10:00:00Z"),
        }),
        fakeSession({
          id: "sess_b",
          intent: "just the intent",
          created_at: new Date("2026-05-01T11:00:00Z"),
        }),
      ]),
    });
    const res = await request(app).get("/chat/conversations");
    const byHead = Object.fromEntries(
      res.body.conversations.map((c: { head_id: string; last_preview: string }) => [
        c.head_id,
        c.last_preview,
      ]),
    );
    expect(byHead.sess_a).toBe("boom");
    expect(byHead.sess_b).toBe("just the intent");
  });

  it("caps the list at 50 conversations", async () => {
    const chats = Array.from({ length: 60 }, (_, i) =>
      fakeSession({
        id: `sess_${i}`,
        created_at: new Date(Date.UTC(2026, 4, 1, 0, i)),
      }),
    );
    const { app } = makeApp({ sessionRepo: makeSessionRepo(chats) });
    const res = await request(app).get("/chat/conversations");
    expect(res.body.conversations).toHaveLength(50);
    // Newest first — sess_59 led the sort.
    expect(res.body.conversations[0].head_id).toBe("sess_59");
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /chat/conversations/:headId", () => {
  it("403s a non-human caller", async () => {
    const { app } = makeApp({}, "agent");
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(403);
  });

  it("404s when the caller has no primary agent", async () => {
    const { app } = makeApp({ agentRepo: makeAgentRepo(null) });
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
  });

  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const sessionRepo = makeSessionRepo();
    (sessionRepo.softDeleteChatChain as ReturnType<typeof vi.fn>).mockResolvedValue(3);
    const { app } = makeApp({ sessionRepo });
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(sessionRepo.softDeleteChatChain).toHaveBeenCalledWith("sess_head", AGENT);
  });

  it("is idempotent — a second delete reports zero rows, still 200", async () => {
    const sessionRepo = makeSessionRepo();
    (sessionRepo.softDeleteChatChain as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    const { app } = makeApp({ sessionRepo });
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("maps a repo throw to the generic 500 envelope with a request id", async () => {
    const sessionRepo = makeSessionRepo();
    (sessionRepo.softDeleteChatChain as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connection terminated"),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({ sessionRepo });
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // The detail stays server-side.
    expect(JSON.stringify(res.body)).not.toContain("connection terminated");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /chat", () => {
  it("403s a non-human caller", async () => {
    const { app } = makeApp({}, "agent");
    expect((await request(app).get("/chat")).status).toBe(403);
  });

  it("returns a null agent envelope when none is provisioned", async () => {
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

  it("returns the most recent chain by default", async () => {
    const older = fakeSession({
      id: "sess_old",
      intent: "older thread",
      result_summary: "old answer",
      created_at: new Date("2026-05-01T09:00:00Z"),
    });
    const newer = fakeSession({
      id: "sess_new",
      intent: "newer thread",
      result_summary: "new answer",
      created_at: new Date("2026-05-01T12:00:00Z"),
    });
    const { app } = makeApp({ sessionRepo: makeSessionRepo([older, newer]) });
    const res = await request(app).get("/chat");
    expect(res.body.conversation_id).toBe("sess_new");
    expect(res.body.prior_session_id).toBe("sess_new");
    expect(res.body.agent).toEqual({ id: AGENT, name: "Ada's team", hierarchy: "team" });
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "newer thread",
      "new answer",
    ]);
  });

  it("selects the chain named by ?c=", async () => {
    const a = fakeSession({
      id: "sess_a",
      intent: "thread a",
      created_at: new Date("2026-05-01T09:00:00Z"),
    });
    const b = fakeSession({
      id: "sess_b",
      intent: "thread b",
      created_at: new Date("2026-05-01T12:00:00Z"),
    });
    const { app } = makeApp({ sessionRepo: makeSessionRepo([a, b]) });
    const res = await request(app).get("/chat").query({ c: "sess_a" });
    expect(res.body.conversation_id).toBe("sess_a");
  });

  it("renders the empty state (not a 404) for an unknown ?c=", async () => {
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_a" })]),
    });
    const res = await request(app).get("/chat").query({ c: "sess_missing" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Ada's team", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("flags an in-flight tail session so the UI can resume its spinner", async () => {
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([
        fakeSession({ id: "sess_running", status: "running", result_summary: undefined }),
      ]),
    });
    const res = await request(app).get("/chat");
    expect(res.body.in_flight_session_id).toBe("sess_running");
  });

  it("omits in_flight_session_id once the tail is terminal", async () => {
    const { app } = makeApp({
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_done", status: "succeeded" })]),
    });
    const res = await request(app).get("/chat");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("truncates history to the most recent 25 sessions", async () => {
    // 30 linked turns; the route keeps ceil(50/2) = 25 (2 messages each).
    const chats = Array.from({ length: 30 }, (_, i) =>
      fakeSession({
        id: `sess_${i}`,
        prior_session_id: i === 0 ? undefined : `sess_${i - 1}`,
        intent: `turn ${i}`,
        result_summary: `answer ${i}`,
        created_at: new Date(Date.UTC(2026, 4, 1, 0, i)),
      }),
    );
    const { app } = makeApp({ sessionRepo: makeSessionRepo(chats) });
    const res = await request(app).get("/chat");
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].content).toBe("turn 5");
    expect(res.body.conversation_id).toBe("sess_0");
  });

  it("reports a runtime mismatch when the chain is pinned to another CLI", async () => {
    const runtimeRepo = makeRuntimeRepo({
      id: "rt_1",
      daemon_id: "dmn_1",
      cli: "codex",
      capabilities: {},
      created_at: new Date("2026-04-01"),
    });
    const { app } = makeApp({
      runtimeRepo,
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_a", runtime_id: "rt_1" })]),
    });
    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toEqual({ pinned_cli: "codex", current_cli: "claude" });
  });

  it("stays quiet when the pinned CLI matches the agent's current one", async () => {
    const runtimeRepo = makeRuntimeRepo({
      id: "rt_1",
      daemon_id: "dmn_1",
      cli: "claude",
      capabilities: {},
      created_at: new Date("2026-04-01"),
    });
    const { app } = makeApp({
      runtimeRepo,
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_a", runtime_id: "rt_1" })]),
    });
    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("stays quiet for an unrecognized CLI string on the pinned runtime", async () => {
    const runtimeRepo = makeRuntimeRepo({
      id: "rt_1",
      daemon_id: "dmn_1",
      cli: "not-a-cli",
      capabilities: {},
      created_at: new Date("2026-04-01"),
    });
    const { app } = makeApp({
      runtimeRepo,
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_a", runtime_id: "rt_1" })]),
    });
    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("skips the runtime probe entirely when the tail has no runtime_id", async () => {
    const runtimeRepo = makeRuntimeRepo();
    const { app } = makeApp({
      runtimeRepo,
      sessionRepo: makeSessionRepo([fakeSession({ id: "sess_a" })]),
    });
    await request(app).get("/chat");
    expect(runtimeRepo.findById).not.toHaveBeenCalled();
  });
});

// ── POST /chat ───────────────────────────────────────────────────────────

describe("POST /chat", () => {
  it("403s a non-human caller", async () => {
    const { app } = makeApp({}, "agent");
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(403);
  });

  it("400s an empty or whitespace-only message", async () => {
    const { app } = makeApp();
    for (const body of [{}, { message: "" }, { message: "   " }, { message: 42 }]) {
      const res = await request(app).post("/chat").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("message_required");
    }
  });

  it("404s when the caller has no primary agent", async () => {
    const { app } = makeApp({ agentRepo: makeAgentRepo(null) });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
  });

  it("dispatches a fresh turn and returns the resolved response", async () => {
    const dispatchService = makeDispatch({
      session: fakeSession({ id: "sess_new" }),
      runtime_id: null,
    });
    const chatResolver = makeResolver(async () =>
      fakeSession({ id: "sess_new", result_summary: "the answer" }),
    );
    const { app } = makeApp({ dispatchService, chatResolver });

    const res = await request(app).post("/chat").send({ message: "  hi there  " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Ada's team", hierarchy: "team" },
      session_id: "sess_new",
      response: "the answer",
      status: "succeeded",
    });
    expect(res.body.replayed).toBeUndefined();
    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: AGENT,
        // Trimmed before dispatch.
        intent: "hi there",
        type: "chat",
        reason: { kind: "fresh" },
      }),
    );
  });

  it("threads prior_session_id through as a chat_continuation resume", async () => {
    const dispatchService = makeDispatch({
      session: fakeSession({ id: "sess_new" }),
      runtime_id: null,
    });
    const { app } = makeApp({ dispatchService });
    await request(app)
      .post("/chat")
      .send({ message: "and then?", prior_session_id: "sess_prior" });
    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_prior" },
      }),
    );
  });

  it("passes a well-formed client session_id through as the override", async () => {
    const dispatchService = makeDispatch({
      session: fakeSession({ id: "sess_abcdefghijkl" }),
      runtime_id: null,
    });
    const chatResolver = makeResolver(async () => fakeSession({ id: "sess_abcdefghijkl" }));
    const { app } = makeApp({ dispatchService, chatResolver });
    await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abcdefghijkl" });
    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: "sess_abcdefghijkl" }),
    );
  });

  it("ignores a malformed session_id rather than minting a bad row", async () => {
    const sessionRepo = makeSessionRepo();
    const dispatchService = makeDispatch({
      session: fakeSession({ id: "sess_new" }),
      runtime_id: null,
    });
    const { app } = makeApp({ sessionRepo, dispatchService });
    await request(app).post("/chat").send({ message: "hi", session_id: "nope" });
    // Never consulted for a replay, and never forwarded.
    expect(sessionRepo.findById).not.toHaveBeenCalled();
    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: undefined }),
    );
  });

  describe("idempotent replay", () => {
    const CLIENT_ID = "sess_abcdefghijkl";

    function replayApp(existing: Session | undefined) {
      const sessionRepo = makeSessionRepo();
      (sessionRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
      const dispatchService = makeDispatch({
        session: fakeSession({ id: CLIENT_ID }),
        runtime_id: null,
      });
      return { ...makeApp({ sessionRepo, dispatchService }), dispatchService };
    }

    it("replays a finished turn instead of spawning another CLI", async () => {
      const { app, dispatchService } = replayApp(
        fakeSession({
          id: CLIENT_ID,
          status: "succeeded",
          result_summary: "cached answer",
        }),
      );
      const res = await request(app)
        .post("/chat")
        .send({ message: "hi", session_id: CLIENT_ID });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        session_id: CLIENT_ID,
        response: "cached answer",
        status: "succeeded",
        replayed: true,
      });
      expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
    });

    it("replays a failed turn with the friendlier failure message", async () => {
      const { app } = replayApp(
        fakeSession({ id: CLIENT_ID, status: "failed", error: "disk full" }),
      );
      const res = await request(app)
        .post("/chat")
        .send({ message: "hi", session_id: CLIENT_ID });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "failed", response: "disk full", replayed: true });
    });

    it("409s while the same session is still running", async () => {
      const { app, dispatchService } = replayApp(
        fakeSession({ id: CLIENT_ID, status: "running" }),
      );
      const res = await request(app)
        .post("/chat")
        .send({ message: "hi", session_id: CLIENT_ID });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("session_in_flight");
      expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
    });

    it("403s when the id collides with another caller's session", async () => {
      const { app } = replayApp(
        fakeSession({ id: CLIENT_ID, agent_id: "agent_someone_else" }),
      );
      const res = await request(app)
        .post("/chat")
        .send({ message: "hi", session_id: CLIENT_ID });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("session_belongs_to_other_caller");
    });

    it("falls through to dispatch when the row isn't a chat session", async () => {
      const { app, dispatchService } = replayApp(
        fakeSession({ id: CLIENT_ID, type: "task" }),
      );
      await request(app).post("/chat").send({ message: "hi", session_id: CLIENT_ID });
      expect(dispatchService.dispatchTask).toHaveBeenCalled();
    });

    it("falls through to dispatch when the pre-minted row is still pending", async () => {
      // `pending` is neither in-flight-enough to 409 nor terminal enough
      // to replay — the caller re-runs.
      const { app, dispatchService } = replayApp(
        fakeSession({ id: CLIENT_ID, status: "pending" }),
      );
      await request(app).post("/chat").send({ message: "hi", session_id: CLIENT_ID });
      expect(dispatchService.dispatchTask).toHaveBeenCalled();
    });

    it("falls through to dispatch when no row exists yet", async () => {
      const { app, dispatchService } = replayApp(undefined);
      await request(app).post("/chat").send({ message: "hi", session_id: CLIENT_ID });
      expect(dispatchService.dispatchTask).toHaveBeenCalled();
    });
  });

  it("429s a second concurrent turn from the same person", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
    // Hold the only slot so the request sees a full limiter.
    const held = rateLimiter.acquire(PERSON);
    expect(held.ok).toBe(true);
    const dispatchService = makeDispatch({
      session: fakeSession({ id: "sess_new" }),
      runtime_id: null,
    });
    const { app } = makeApp({ rateLimiter, dispatchService });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("turn_in_flight");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("429s with rate_limited once the sliding window is spent", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 5, maxPerWindow: 1 });
    rateLimiter.acquire(PERSON);
    const { app } = makeApp({ rateLimiter });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.body.retry_after_ms).toBeGreaterThan(0);
  });

  it("releases the rate-limit slot after a successful turn", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const { app } = makeApp({ rateLimiter });
    expect((await request(app).post("/chat").send({ message: "one" })).status).toBe(200);
    // Slot returned — a follow-up turn isn't throttled.
    expect((await request(app).post("/chat").send({ message: "two" })).status).toBe(200);
  });

  it("503s and releases the slot when the bound daemon is offline", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const chatResolver = makeResolver(async () => fakeSession({ id: "sess_new" }));
    const { app } = makeApp({
      rateLimiter,
      hub: makeHub(false),
      dispatchService: makeDispatch({
        session: fakeSession({ id: "sess_new" }),
        runtime_id: "rt_1",
      }),
      chatResolver,
    });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(chatResolver.register).not.toHaveBeenCalled();
    // Slot was released, so the next attempt isn't a 429.
    expect((await request(app).post("/chat").send({ message: "hi" })).status).toBe(503);
  });

  it("runs the null-runtime executor path without consulting the hub", async () => {
    const hub = makeHub(false);
    const { app } = makeApp({
      hub,
      dispatchService: makeDispatch({
        session: fakeSession({ id: "sess_new" }),
        runtime_id: null,
      }),
    });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(hub.isOnline).not.toHaveBeenCalled();
  });

  it("504s when the resolver times out", async () => {
    const chatResolver = makeResolver(async () => {
      throw new Error("chat resolver timeout (90000ms) for sess_new");
    });
    const { app } = makeApp({ chatResolver });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ error: "chat_turn_timeout", timeout_ms: 90_000 });
  });

  it("500s on a non-timeout resolver failure", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const chatResolver = makeResolver(async () => {
      throw new Error("resolver exploded");
    });
    const { app } = makeApp({ chatResolver });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    err.mockRestore();
  });

  it("500s and releases the slot when dispatch itself throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const dispatchService = {
      dispatchTask: vi.fn(async () => {
        throw new Error("agent not found");
      }),
    } as unknown as DispatchService;
    const { app } = makeApp({ rateLimiter, dispatchService });

    const first = await request(app).post("/chat").send({ message: "hi" });
    expect(first.status).toBe(500);
    // Not 429 — the slot came back.
    expect((await request(app).post("/chat").send({ message: "hi" })).status).toBe(500);
    err.mockRestore();
  });

  it("flips onboarding_completed_at on the first successful turn", async () => {
    const personRepo = makePersonRepo(fakePerson({ onboarding_completed_at: undefined }));
    const { app } = makeApp({ personRepo });
    await request(app).post("/chat").send({ message: "hi" });
    expect(personRepo.update).toHaveBeenCalledWith(
      PERSON,
      expect.objectContaining({ onboarding_completed_at: expect.any(Date) }),
    );
  });

  it("leaves onboarding_completed_at alone once already set", async () => {
    const personRepo = makePersonRepo(
      fakePerson({ onboarding_completed_at: new Date("2026-04-02") }),
    );
    const { app } = makeApp({ personRepo });
    await request(app).post("/chat").send({ message: "hi" });
    expect(personRepo.update).not.toHaveBeenCalled();
  });

  it("does not flip onboarding when the first turn failed", async () => {
    const personRepo = makePersonRepo(fakePerson({ onboarding_completed_at: undefined }));
    const chatResolver = makeResolver(async () =>
      fakeSession({ id: "sess_new", status: "failed", error: "nope" }),
    );
    const { app } = makeApp({ personRepo, chatResolver });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.body.status).toBe("failed");
    expect(personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers the turn when the onboarding flip write rejects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const personRepo = makePersonRepo(fakePerson({ onboarding_completed_at: undefined }));
    (personRepo.update as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("write failed"));
    const { app } = makeApp({ personRepo });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    // Fire-and-forget: let the rejection handler run before asserting.
    await new Promise((r) => setImmediate(r));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
