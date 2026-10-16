/**
 * /chat HTTP surface — unit tests with vitest fakes (no DB, no CLI).
 *
 * `chat-internals.test.ts` already pins the pure helpers
 * (`groupIntoConversations`, `chainToMessages`, `failureMessageFor`);
 * this file covers the four handlers `createChatRouter` mounts, which
 * is where the money-shaped branches live:
 *
 *   - POST /chat gates in a fixed order — human → non-empty message →
 *     primary agent → idempotent replay → rate limit → dispatch →
 *     daemon-online. Each gate short-circuits with its own status, and
 *     every path that bails after `rateLimiter.acquire` must release the
 *     slot or the caller is wedged until the window rolls.
 *   - GET /chat reconstructs the newest (or `?c=`-selected) chain and
 *     flags a runtime mismatch between the chain's pin and the agent's
 *     current CLI.
 *   - GET /chat/conversations shapes the thread list (title truncation,
 *     preview precedence).
 *   - DELETE /chat/conversations/:headId is scoped to the caller's own
 *     primary agent.
 *
 * The resolver is faked: `ChatResolver` itself is covered by
 * `runtime/chat-resolver.test.ts`, and the route's 90s timeout is far
 * too long to drive through the real one.
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
import type {
  DispatchInput,
  DispatchService,
} from "@beevibe/core/services/dispatch-service";
import type { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { createChatRouter } from "./chat.js";

const PERSON = "person_1";
const AGENT = "agent_a";

// ── Fakes ────────────────────────────────────────────────────────────────

function makeAgentRepo(): AgentRepository {
  return {
    findById: vi.fn(),
    findByApiKey: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findParent: vi.fn(),
    findByLevel: vi.fn(),
    findDescendantIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as AgentRepository;
}

function makePersonRepo(): PersonRepository {
  return {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findByApiKey: vi.fn(),
    findManyByIds: vi.fn(),
    create: vi.fn(),
    // The route fires the onboarding flip and `.catch`es it, so the
    // default has to be a real promise even where the test ignores it.
    update: vi.fn(async () => fakePerson()),
    delete: vi.fn(),
  } as unknown as PersonRepository;
}

function makeSessionRepo(): SessionRepository {
  return {
    findById: vi.fn(),
    listChatForAgent: vi.fn(async () => []),
    softDeleteChatChain: vi.fn(),
  } as unknown as SessionRepository;
}

function makeRuntimeRepo(): RuntimeRepository {
  return { findById: vi.fn() } as unknown as RuntimeRepository;
}

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

function fakeRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    id: "rt_1",
    daemon_id: "daemon_1",
    cli: "claude",
    capabilities: {},
    created_at: new Date("2026-04-01"),
    ...overrides,
  };
}

/** Resolver stub — the route only ever calls `register`. */
function makeResolver(
  register: (sessionId: string, timeoutMs: number) => Promise<Session>,
): ChatResolver {
  return { register: vi.fn(register) } as unknown as ChatResolver;
}

function makeHub(isOnline = true): DaemonHub {
  return { isOnline: vi.fn(() => isOnline) } as unknown as DaemonHub;
}

function makeDispatch(
  dispatchTask: DispatchService["dispatchTask"] = vi.fn(async () => ({
    session: fakeSession({ id: "sess_aaaaaaaaaaaa", status: "pending" }),
    runtime_id: null,
  })) as unknown as DispatchService["dispatchTask"],
): DispatchService {
  return { dispatchTask } as unknown as DispatchService;
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
  const agentRepo = opts.agentRepo ?? makeAgentRepo();
  const personRepo = opts.personRepo ?? makePersonRepo();
  const sessionRepo = opts.sessionRepo ?? makeSessionRepo();
  const runtimeRepo = opts.runtimeRepo ?? makeRuntimeRepo();
  const dispatchService = opts.dispatchService ?? makeDispatch();
  const hub = opts.hub ?? makeHub();
  const chatResolver =
    opts.chatResolver ??
    makeResolver(async (id) => fakeSession({ id, status: "succeeded", result_summary: "hi" }));
  const app = express();
  app.use(json());
  app.use(
    "/chat",
    createChatRouter({
      authMiddleware: stubAuth(opts.source ?? "human"),
      agentRepo,
      personRepo,
      runtimeRepo,
      sessionRepo,
      dispatchService,
      chatResolver,
      hub,
      ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
    }),
  );
  return { app, agentRepo, personRepo, sessionRepo, runtimeRepo, dispatchService, hub, chatResolver };
}

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /chat/conversations", () => {
  it("403s a non-human caller", async () => {
    const { app } = makeApp({ source: "agent" });
    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);
    const { app, sessionRepo } = makeApp({ agentRepo });
    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain: title from the head, turn count, last activity", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_head00000",
        intent: "plan the migration",
        result_summary: "first reply",
        created_at: new Date("2026-05-01T10:00:00Z"),
      }),
      fakeSession({
        id: "sess_tail00000",
        prior_session_id: "sess_head00000",
        intent: "and the rollback?",
        result_summary: "second reply",
        created_at: new Date("2026-05-01T10:05:00Z"),
      }),
    ]);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head00000",
        title: "plan the migration",
        turn_count: 2,
        last_at: "2026-05-01T10:05:00.000Z",
        last_preview: "second reply",
      },
    ]);
  });

  it("truncates a long head intent into the thread title", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_long00000", intent: "x".repeat(200) }),
    ]);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat/conversations");
    const title = res.body.conversations[0].title as string;
    expect(title).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("previews the agent reply with directives stripped, and collapses whitespace", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_dir000000",
        result_summary: 'Done.\n\n<open_view path="/tasks" />',
      }),
    ]);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat/conversations");
    expect(res.body.conversations[0].last_preview).toBe("Done.");
  });

  it("falls back to error then intent when there is no result_summary", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_err000000",
        status: "failed",
        error: "boom",
        created_at: new Date("2026-05-01T11:00:00Z"),
      }),
      fakeSession({
        id: "sess_bare00000",
        status: "pending",
        intent: "still thinking",
        created_at: new Date("2026-05-01T12:00:00Z"),
      }),
    ]);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat/conversations");
    const previews = (res.body.conversations as Array<{ last_preview: string }>).map(
      (c) => c.last_preview,
    );
    expect(previews).toEqual(["still thinking", "boom"]);
  });

  it("truncates a preview longer than the 140-char budget", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_big000000", result_summary: "y".repeat(500) }),
    ]);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat/conversations");
    const preview = res.body.conversations[0].last_preview as string;
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("caps the list at 50 conversations", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue(
      Array.from({ length: 60 }, (_, i) =>
        fakeSession({
          id: `sess_${String(i).padStart(12, "0")}`,
          created_at: new Date(Date.UTC(2026, 4, 1, 0, i)),
        }),
      ),
    );
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat/conversations");
    expect(res.body.conversations).toHaveLength(50);
    // Newest-first: the 60th session heads the first conversation.
    expect(res.body.conversations[0].head_id).toBe("sess_000000000059");
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /chat/conversations/:headId", () => {
  it("403s a non-human caller", async () => {
    const { app } = makeApp({ source: "none" });
    const res = await request(app).delete("/chat/conversations/sess_head00000");
    expect(res.status).toBe(403);
  });

  it("404s when the caller has no primary agent", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);
    const { app } = makeApp({ agentRepo });
    const res = await request(app).delete("/chat/conversations/sess_head00000");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
  });

  it("soft-deletes the chain scoped to the caller's own agent", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.softDeleteChatChain).mockResolvedValue(3);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).delete("/chat/conversations/sess_head00000");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(sessionRepo.softDeleteChatChain).toHaveBeenCalledWith("sess_head00000", AGENT);
  });

  it("is idempotent — a second delete reports zero rows, still 200", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.softDeleteChatChain).mockResolvedValue(0);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).delete("/chat/conversations/sess_head00000");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("500s with a request_id when the repo throws", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.softDeleteChatChain).mockRejectedValue(new Error("pg down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).delete("/chat/conversations/sess_head00000");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // The detail stays server-side, keyed by the id the client can quote.
    expect(spy.mock.calls[0]?.[0]).toContain(res.body.request_id);
    spy.mockRestore();
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /chat", () => {
  it("403s a non-human caller", async () => {
    const { app } = makeApp({ source: "agent" });
    const res = await request(app).get("/chat");
    expect(res.status).toBe(403);
  });

  it("returns a null agent and no messages when none is provisioned", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);
    const { app } = makeApp({ agentRepo });
    const res = await request(app).get("/chat");
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns the agent with an empty chain when there are no chat sessions", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const { app } = makeApp({ agentRepo });
    const res = await request(app).get("/chat");
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Ada's team", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("rehydrates the newest chain by default", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_old000000",
        intent: "older thread",
        result_summary: "older reply",
        created_at: new Date("2026-05-01T09:00:00Z"),
      }),
      fakeSession({
        id: "sess_new000000",
        intent: "newer thread",
        result_summary: "newer reply",
        created_at: new Date("2026-05-01T10:00:00Z"),
      }),
    ]);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat");
    expect(res.body.conversation_id).toBe("sess_new000000");
    expect(res.body.prior_session_id).toBe("sess_new000000");
    expect(res.body.messages).toEqual([
      { id: "u_sess_new000000", role: "user", content: "newer thread" },
      {
        id: "a_sess_new000000",
        role: "agent",
        content: "newer reply",
        session_id: "sess_new000000",
      },
    ]);
  });

  it("selects the chain named by ?c=", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_old000000",
        intent: "older thread",
        created_at: new Date("2026-05-01T09:00:00Z"),
      }),
      fakeSession({
        id: "sess_new000000",
        intent: "newer thread",
        created_at: new Date("2026-05-01T10:00:00Z"),
      }),
    ]);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat").query({ c: "sess_old000000" });
    expect(res.body.conversation_id).toBe("sess_old000000");
  });

  it("renders the empty state (not a 404) for an unknown ?c=", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_new000000" }),
    ]);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat").query({ c: "sess_nope00000" });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
  });

  it("keeps only the newest 25 turns of a long chain", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    // One chain of 30 turns: head plus 29 continuations.
    const chain = Array.from({ length: 30 }, (_, i) =>
      fakeSession({
        id: `sess_${String(i).padStart(12, "0")}`,
        ...(i === 0 ? {} : { prior_session_id: `sess_${String(i - 1).padStart(12, "0")}` }),
        intent: `turn ${i}`,
        result_summary: `reply ${i}`,
        created_at: new Date(Date.UTC(2026, 4, 1, 0, i)),
      }),
    );
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue(chain);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat");
    // 25 sessions × (user + agent) bubbles.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].content).toBe("turn 5");
    // prior_session_id still points at the real chain tail.
    expect(res.body.prior_session_id).toBe("sess_000000000029");
  });

  it("renders a failed turn in history with the friendlier failure message", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_fail00000",
        intent: "deploy it",
        status: "failed",
        result_summary: undefined,
        error: "npm ERR! missing script: deploy",
      }),
    ]);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat");
    expect(res.body.messages).toEqual([
      { id: "u_sess_fail00000", role: "user", content: "deploy it" },
      {
        id: "a_sess_fail00000",
        role: "agent",
        content: "npm ERR! missing script: deploy",
        session_id: "sess_fail00000",
      },
    ]);
  });

  it("surfaces in_flight_session_id while the tail turn is still running", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_run000000", status: "running", result_summary: undefined }),
    ]);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat");
    expect(res.body.in_flight_session_id).toBe("sess_run000000");
    // The user bubble is there; the agent reply slot stays empty.
    expect(res.body.messages).toEqual([
      { id: "u_sess_run000000", role: "user", content: "hello" },
    ]);
  });

  it("omits in_flight_session_id once the tail turn is terminal", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_done00000", result_summary: "done" }),
    ]);
    const { app } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app).get("/chat");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("reports a runtime mismatch when the chain's pin differs from the agent's CLI", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(
      fakeAgent({ runtime_config: { type: "codex" } }),
    );
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_pin000000", runtime_id: "rt_1" }),
    ]);
    const runtimeRepo = makeRuntimeRepo();
    vi.mocked(runtimeRepo.findById).mockResolvedValue(fakeRuntime({ cli: "claude" }));
    const { app } = makeApp({ agentRepo, sessionRepo, runtimeRepo });

    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toEqual({
      pinned_cli: "claude",
      current_cli: "codex",
    });
  });

  it("reports no mismatch when the pin matches the agent's CLI", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_pin000000", runtime_id: "rt_1" }),
    ]);
    const runtimeRepo = makeRuntimeRepo();
    vi.mocked(runtimeRepo.findById).mockResolvedValue(fakeRuntime({ cli: "claude" }));
    const { app } = makeApp({ agentRepo, sessionRepo, runtimeRepo });

    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("reports no mismatch for an unpinned chain, a vanished runtime row, or an unknown CLI", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(
      fakeAgent({ runtime_config: { type: "codex" } }),
    );
    const runtimeRepo = makeRuntimeRepo();

    // (a) tail session carries no runtime_id — the repo isn't even asked.
    const unpinned = makeSessionRepo();
    vi.mocked(unpinned.listChatForAgent).mockResolvedValue([fakeSession({ id: "sess_nopin0000" })]);
    const a = makeApp({ agentRepo, sessionRepo: unpinned, runtimeRepo });
    expect((await request(a.app).get("/chat")).body.runtime_mismatch).toBeUndefined();
    expect(runtimeRepo.findById).not.toHaveBeenCalled();

    const pinned = makeSessionRepo();
    vi.mocked(pinned.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_pin000000", runtime_id: "rt_gone" }),
    ]);

    // (b) runtime row deleted out from under the chain.
    vi.mocked(runtimeRepo.findById).mockResolvedValue(undefined);
    const b = makeApp({ agentRepo, sessionRepo: pinned, runtimeRepo });
    expect((await request(b.app).get("/chat")).body.runtime_mismatch).toBeUndefined();

    // (c) row exists but its cli isn't one we know how to name.
    vi.mocked(runtimeRepo.findById).mockResolvedValue(fakeRuntime({ cli: "cursor" }));
    const c = makeApp({ agentRepo, sessionRepo: pinned, runtimeRepo });
    expect((await request(c.app).get("/chat")).body.runtime_mismatch).toBeUndefined();
  });
});

// ── POST /chat ───────────────────────────────────────────────────────────

describe("POST /chat", () => {
  it("403s a non-human caller", async () => {
    const { app } = makeApp({ source: "agent" });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(403);
  });

  it("400s on a missing, non-string or whitespace-only message", async () => {
    const { app } = makeApp();
    for (const body of [{}, { message: 42 }, { message: "   " }]) {
      const res = await request(app).post("/chat").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("message_required");
    }
  });

  it("404s when the caller has no primary agent", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);
    const { app, dispatchService } = makeApp({ agentRepo });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("dispatches a fresh chat turn and returns the agent's reply", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const personRepo = makePersonRepo();
    vi.mocked(personRepo.findById).mockResolvedValue(
      fakePerson({ onboarding_completed_at: new Date("2026-04-02") }),
    );
    const dispatchTask = vi.fn(async (_input: DispatchInput) => ({
      session: fakeSession({ id: "sess_fresh00000", status: "pending" }),
      runtime_id: null,
    }));
    const chatResolver = makeResolver(async (id) =>
      fakeSession({ id, status: "succeeded", result_summary: "Here you go." }),
    );
    const { app } = makeApp({
      agentRepo,
      personRepo,
      dispatchService: makeDispatch(dispatchTask as never),
      chatResolver,
    });

    const res = await request(app).post("/chat").send({ message: "  hi there  " });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Ada's team", hierarchy: "team" },
      session_id: "sess_fresh00000",
      response: "Here you go.",
      status: "succeeded",
      view_refs: [],
    });
    // Message trimmed; no prior session → `fresh` resume reason.
    expect(dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      intent: "hi there",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
  });

  it("passes prior_session_id through as a chat_continuation resume reason", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const dispatchTask = vi.fn(async (_input: DispatchInput) => ({
      session: fakeSession({ id: "sess_cont00000", status: "pending" }),
      runtime_id: null,
    }));
    const { app } = makeApp({ agentRepo, dispatchService: makeDispatch(dispatchTask as never) });

    await request(app)
      .post("/chat")
      .send({ message: "and then?", prior_session_id: "sess_prior00000" });
    expect(dispatchTask.mock.calls[0]?.[0]).toMatchObject({
      reason: { kind: "chat_continuation", prior_session_id: "sess_prior00000" },
    });
  });

  it("forwards a well-formed client session_id as the override, ignoring a malformed one", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.findById).mockResolvedValue(undefined);
    const dispatchTask = vi.fn(async (_input: DispatchInput) => ({
      session: fakeSession({ id: "sess_abcdefghijkl", status: "pending" }),
      runtime_id: null,
    }));
    const { app } = makeApp({
      agentRepo,
      sessionRepo,
      dispatchService: makeDispatch(dispatchTask as never),
    });

    await request(app).post("/chat").send({ message: "hi", session_id: "sess_abcdefghijkl" });
    expect(dispatchTask.mock.calls[0]?.[0]).toMatchObject({
      sessionIdOverride: "sess_abcdefghijkl",
    });

    // "not-a-session-id" fails the sess_<12 alnum> shape → no override and
    // no replay lookup.
    await request(app).post("/chat").send({ message: "hi", session_id: "nope" });
    expect(dispatchTask.mock.calls[1]?.[0]).toMatchObject({ sessionIdOverride: undefined });
    expect(sessionRepo.findById).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed turn through the friendlier failure mapping", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const chatResolver = makeResolver(async (id) =>
      fakeSession({
        id,
        status: "failed",
        result_summary: undefined,
        error: "CLI exited with code 1",
      }),
    );
    const { app } = makeApp({ agentRepo, chatResolver });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    // Bare exit line is useless to the user → daemon-log pointer instead.
    expect(res.body.response).toContain("beevibe-daemon start");
  });

  it("splits display directives out of the reply body", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const chatResolver = makeResolver(async (id) =>
      fakeSession({
        id,
        result_summary:
          'Filed it.\n<open_view path="/tasks" label="See tasks" />\n' +
          '<suggest_action label="Ship it" prompt="ship the task" />',
      }),
    );
    const { app } = makeApp({ agentRepo, chatResolver });

    const res = await request(app).post("/chat").send({ message: "file a task" });
    expect(res.body.response).toBe("Filed it.");
    expect(res.body.open_view).toEqual({ path: "/tasks", label: "See tasks" });
    expect(res.body.suggested_actions).toEqual([{ label: "Ship it", prompt: "ship the task" }]);
  });

  // ── Idempotent replay ──────────────────────────────────────────────────

  it("replays a finished turn instead of dispatching a second one", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      fakeSession({ id: "sess_abcdefghijkl", result_summary: "already answered" }),
    );
    const { app, dispatchService } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abcdefghijkl" });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.response).toBe("already answered");
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("409s while the replayed session is still running", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      fakeSession({ id: "sess_abcdefghijkl", status: "running" }),
    );
    const { app, dispatchService } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abcdefghijkl" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the session id collides with another caller's session", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      fakeSession({ id: "sess_abcdefghijkl", agent_id: "agent_other" }),
    );
    const { app, dispatchService } = makeApp({ agentRepo, sessionRepo });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abcdefghijkl" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("falls through to dispatch for a pending row or a non-chat row", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const sessionRepo = makeSessionRepo();
    const dispatchTask = vi.fn(async (_input: DispatchInput) => ({
      session: fakeSession({ id: "sess_abcdefghijkl", status: "pending" }),
      runtime_id: null,
    }));
    const { app } = makeApp({
      agentRepo,
      sessionRepo,
      dispatchService: makeDispatch(dispatchTask as never),
    });

    // Pending: claimed but not yet terminal — re-dispatch is the contract.
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      fakeSession({ id: "sess_abcdefghijkl", status: "pending" }),
    );
    expect((await request(app).post("/chat").send({ message: "hi", session_id: "sess_abcdefghijkl" })).status).toBe(200);

    // A task-typed row with the same id isn't a chat replay candidate.
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      fakeSession({ id: "sess_abcdefghijkl", type: "task" }),
    );
    expect((await request(app).post("/chat").send({ message: "hi", session_id: "sess_abcdefghijkl" })).status).toBe(200);

    expect(dispatchTask).toHaveBeenCalledTimes(2);
  });

  // ── Rate limiting ──────────────────────────────────────────────────────

  it("429s a second concurrent turn for the same person", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    // Hold the only slot so the request hits the concurrent branch.
    rateLimiter.acquire(PERSON);
    const { app, dispatchService } = makeApp({ agentRepo, rateLimiter });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("turn_in_flight");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("429s once the sliding window is spent", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const rateLimiter = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 1,
      windowMs: 60_000,
      now: () => 1_000,
    });
    rateLimiter.acquire(PERSON).ok && rateLimiter.acquire(PERSON);
    const { app } = makeApp({ agentRepo, rateLimiter });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.body.retry_after_ms).toBeGreaterThan(0);
  });

  it("releases the rate-limit slot after a successful turn", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const { app } = makeApp({ agentRepo, rateLimiter });

    expect((await request(app).post("/chat").send({ message: "one" })).status).toBe(200);
    // A wedged release would turn this into a 429.
    expect((await request(app).post("/chat").send({ message: "two" })).status).toBe(200);
  });

  it("releases the rate-limit slot when dispatch throws", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const dispatchTask = vi
      .fn()
      .mockRejectedValueOnce(new Error("agent not found"))
      .mockResolvedValue({
        session: fakeSession({ id: "sess_after000000", status: "pending" }),
        runtime_id: null,
      });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({
      agentRepo,
      rateLimiter,
      dispatchService: makeDispatch(dispatchTask as never),
    });

    const failed = await request(app).post("/chat").send({ message: "one" });
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe("internal_error");
    expect((await request(app).post("/chat").send({ message: "two" })).status).toBe(200);
    spy.mockRestore();
  });

  // ── Daemon reachability + resolver outcomes ────────────────────────────

  it("503s a daemon-bound turn when no daemon is online, and frees the slot", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const dispatchTask = vi.fn(async (_input: DispatchInput) => ({
      session: fakeSession({ id: "sess_off000000", status: "pending" }),
      runtime_id: "rt_1",
    }));
    const { app, hub, chatResolver } = makeApp({
      agentRepo,
      rateLimiter,
      hub: makeHub(false),
      dispatchService: makeDispatch(dispatchTask as never),
    });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(hub.isOnline).toHaveBeenCalledWith("rt_1");
    // Bailed before registering a resolver, and the slot came back.
    expect(chatResolver.register).not.toHaveBeenCalled();
    expect(rateLimiter.acquire(PERSON).ok).toBe(true);
  });

  it("does not check the hub for a null-runtime turn (executor fallback)", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const { app, hub } = makeApp({ agentRepo, hub: makeHub(false) });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(hub.isOnline).not.toHaveBeenCalled();
  });

  it("504s when the resolver times out waiting for /runtime/done", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const chatResolver = makeResolver(async (id, timeoutMs) => {
      throw new Error(`chat resolver timeout (${timeoutMs}ms) for ${id}`);
    });
    const { app } = makeApp({ agentRepo, chatResolver });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(504);
    expect(res.body.error).toBe("chat_turn_timeout");
    expect(res.body.timeout_ms).toBe(90_000);
  });

  it("500s when the resolver rejects for some other reason", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const chatResolver = makeResolver(async () => {
      throw new Error("resolver already registered");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({ agentRepo, chatResolver });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    spy.mockRestore();
  });

  // ── Onboarding flip ───────────────────────────────────────────────────

  it("flips onboarding_completed_at on the first succeeding turn", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const personRepo = makePersonRepo();
    vi.mocked(personRepo.findById).mockResolvedValue(fakePerson());
    vi.mocked(personRepo.update).mockResolvedValue(fakePerson());
    const { app } = makeApp({ agentRepo, personRepo });

    await request(app).post("/chat").send({ message: "hi" });
    expect(personRepo.update).toHaveBeenCalledWith(PERSON, {
      onboarding_completed_at: expect.any(Date),
    });
  });

  it("leaves onboarding_completed_at alone when it is already set, or the turn failed", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());

    const done = makePersonRepo();
    vi.mocked(done.findById).mockResolvedValue(
      fakePerson({ onboarding_completed_at: new Date("2026-04-02") }),
    );
    const a = makeApp({ agentRepo, personRepo: done });
    await request(a.app).post("/chat").send({ message: "hi" });
    expect(done.update).not.toHaveBeenCalled();

    const fresh = makePersonRepo();
    vi.mocked(fresh.findById).mockResolvedValue(fakePerson());
    const b = makeApp({
      agentRepo,
      personRepo: fresh,
      chatResolver: makeResolver(async (id) =>
        fakeSession({ id, status: "failed", error: "spawn failed" }),
      ),
    });
    await request(b.app).post("/chat").send({ message: "hi" });
    expect(fresh.update).not.toHaveBeenCalled();
  });

  it("still answers when the onboarding flip write fails", async () => {
    const agentRepo = makeAgentRepo();
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(fakeAgent());
    const personRepo = makePersonRepo();
    vi.mocked(personRepo.findById).mockResolvedValue(fakePerson());
    vi.mocked(personRepo.update).mockRejectedValue(new Error("pg down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({ agentRepo, personRepo });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Fire-and-forget: the rejection is logged, not surfaced.
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
