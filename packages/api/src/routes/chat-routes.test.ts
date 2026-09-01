/**
 * `createChatRouter` handler tests — supertest over vitest fakes (no DB).
 *
 * `chat-internals.test.ts` already pins the exported pure helpers
 * (`groupIntoConversations`, `chainToMessages`, `failureMessageFor`).
 * What was untested is the router itself: four handlers whose branches
 * are the ones a user actually hits — the human gate, the "no primary
 * agent" shapes, the idempotent-replay ladder (403 / 409 / 200 replayed
 * / fall-through), the rate limiter's 429, the offline-daemon 503, and
 * the resolver's 504-vs-500 split. Every one of those returns a
 * distinct wire shape the web client branches on.
 *
 * The router is a closure over seven ports, so a bag of `vi.fn()` repos
 * plus a stub auth middleware reaches all of it. `processResponse` and
 * `groupIntoConversations` run for real — their output is part of the
 * wire contract asserted here.
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
import { createChatRouter } from "./chat.js";

const PERSON = "person_alice";
const AGENT = "agent_alice_team";

// ── Fakes ────────────────────────────────────────────────────────────────

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

function fakePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: PERSON,
    name: "Alice",
    email: "alice@example.com",
    capability_network_enabled: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Person;
}

let sessionSeq = 0;
function fakeSession(overrides: Partial<Session> = {}): Session {
  sessionSeq += 1;
  return {
    id: `sess_${String(sessionSeq).padStart(12, "0")}`,
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as unknown as Session;
}

interface Fakes {
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  runtimeRepo: RuntimeRepository;
  sessionRepo: SessionRepository;
  dispatchService: DispatchService;
  chatResolver: ChatResolver;
  hub: DaemonHub;
  rateLimiter: ChatRateLimiter;
}

function makeFakes(): Fakes {
  return {
    agentRepo: { findTopLevelForOwner: vi.fn() } as unknown as AgentRepository,
    personRepo: {
      findById: vi.fn().mockResolvedValue(
        fakePerson({ onboarding_completed_at: new Date("2026-01-01T00:00:00Z") }),
      ),
      update: vi.fn().mockResolvedValue(fakePerson()),
    } as unknown as PersonRepository,
    runtimeRepo: { findById: vi.fn() } as unknown as RuntimeRepository,
    sessionRepo: {
      findById: vi.fn(),
      listChatForAgent: vi.fn().mockResolvedValue([]),
      softDeleteChatChain: vi.fn().mockResolvedValue(0),
    } as unknown as SessionRepository,
    dispatchService: { dispatchTask: vi.fn() } as unknown as DispatchService,
    chatResolver: { register: vi.fn() } as unknown as ChatResolver,
    hub: { isOnline: vi.fn().mockReturnValue(true) } as unknown as DaemonHub,
    // maxPerWindow high enough that only the tests that mean to trip the
    // limiter do; concurrency stays at the production default of 1.
    rateLimiter: new ChatRateLimiter({ maxPerWindow: 1000 }),
  };
}

function stubAuth(source: "human" | "agent") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.caller =
      source === "human"
        ? { source: "human", agentId: AGENT, hierarchyLevel: "team", personId: PERSON }
        : { source: "agent", agentId: AGENT, hierarchyLevel: "ic" };
    next();
  };
}

function makeApp(fakes: Fakes, source: "human" | "agent" = "human") {
  const app = express();
  app.use(json());
  app.use(
    "/chat",
    createChatRouter({
      authMiddleware: stubAuth(source),
      agentRepo: fakes.agentRepo,
      personRepo: fakes.personRepo,
      runtimeRepo: fakes.runtimeRepo,
      sessionRepo: fakes.sessionRepo,
      dispatchService: fakes.dispatchService,
      chatResolver: fakes.chatResolver,
      hub: fakes.hub,
      rateLimiter: fakes.rateLimiter,
    }),
  );
  return app;
}

/** Convenience: caller has a primary agent and it's the default one. */
function withAgent(fakes: Fakes, agent: Agent = fakeAgent()): Agent {
  vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(agent);
  return agent;
}

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /chat/conversations", () => {
  it("403s a non-human caller", async () => {
    const fakes = makeFakes();
    const res = await request(makeApp(fakes, "agent")).get("/chat/conversations");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);
    const res = await request(makeApp(fakes)).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(fakes.sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain: title from the head, turn count, last preview", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    const head = fakeSession({
      id: "sess_head",
      intent: "plan the launch",
      result_summary: "sure",
      created_at: new Date("2026-01-01T10:00:00Z"),
    });
    const tail = fakeSession({
      id: "sess_tail",
      prior_session_id: "sess_head",
      intent: "and the budget?",
      result_summary: "  drafted   the\nbudget  ",
      created_at: new Date("2026-01-01T10:05:00Z"),
    });
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([tail, head]);

    const res = await request(makeApp(fakes)).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head",
        title: "plan the launch",
        turn_count: 2,
        last_at: "2026-01-01T10:05:00.000Z",
        // Whitespace collapsed to single spaces and trimmed.
        last_preview: "drafted the budget",
      },
    ]);
  });

  it("truncates a long title at CHAT_THREAD_TITLE_MAX with an ellipsis", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    const intent = "x".repeat(200);
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_long", intent, result_summary: "ok" }),
    ]);

    const res = await request(makeApp(fakes)).get("/chat/conversations");
    const title = res.body.conversations[0].title as string;
    expect(title).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("previews the error, then the intent, when there is no result_summary", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_err",
        intent: "do the thing",
        status: "failed",
        error: "boom",
        created_at: new Date("2026-01-01T11:00:00Z"),
      }),
      fakeSession({
        id: "sess_bare",
        intent: "no reply yet",
        status: "pending",
        created_at: new Date("2026-01-01T10:00:00Z"),
      }),
    ]);

    const res = await request(makeApp(fakes)).get("/chat/conversations");
    const previews = Object.fromEntries(
      (res.body.conversations as { head_id: string; last_preview: string }[]).map((c) => [
        c.head_id,
        c.last_preview,
      ]),
    );
    expect(previews.sess_err).toBe("boom");
    expect(previews.sess_bare).toBe("no reply yet");
  });

  it("clips an over-long preview to 140 chars including the ellipsis", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_p", result_summary: "y".repeat(500) }),
    ]);

    const res = await request(makeApp(fakes)).get("/chat/conversations");
    const preview = res.body.conversations[0].last_preview as string;
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("…")).toBe(true);
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /chat/conversations/:headId", () => {
  it("403s a non-human caller", async () => {
    const fakes = makeFakes();
    const res = await request(makeApp(fakes, "agent")).delete("/chat/conversations/sess_h");
    expect(res.status).toBe(403);
  });

  it("404s when the caller has no primary agent", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);
    const res = await request(makeApp(fakes)).delete("/chat/conversations/sess_h");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
  });

  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.softDeleteChatChain).mockResolvedValue(3);

    const res = await request(makeApp(fakes)).delete("/chat/conversations/sess_h");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(fakes.sessionRepo.softDeleteChatChain).toHaveBeenCalledWith("sess_h", AGENT);
  });

  it("is idempotent — a second delete reports 0 rows, still 200", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.softDeleteChatChain).mockResolvedValue(0);
    const res = await request(makeApp(fakes)).delete("/chat/conversations/sess_h");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("500s with a request_id (and no internal detail) when the repo throws", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.softDeleteChatChain).mockRejectedValue(
      new Error("connection terminated unexpectedly"),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(makeApp(fakes)).delete("/chat/conversations/sess_h");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    expect(JSON.stringify(res.body)).not.toContain("connection terminated");
    spy.mockRestore();
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /chat", () => {
  it("403s a non-human caller", async () => {
    const fakes = makeFakes();
    const res = await request(makeApp(fakes, "agent")).get("/chat");
    expect(res.status).toBe(403);
  });

  it("returns the null-agent shape when nothing is provisioned", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);
    const res = await request(makeApp(fakes)).get("/chat");
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("renders the most recent chain as user/agent message pairs", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_h",
        intent: "hi",
        result_summary: "hello back",
        created_at: new Date("2026-01-01T10:00:00Z"),
      }),
    ]);

    const res = await request(makeApp(fakes)).get("/chat");
    expect(res.status).toBe(200);
    expect(res.body.agent).toEqual({ id: AGENT, name: "Alice's Team", hierarchy: "team" });
    expect(res.body.messages).toEqual([
      { id: "u_sess_h", role: "user", content: "hi" },
      { id: "a_sess_h", role: "agent", content: "hello back", session_id: "sess_h" },
    ]);
    expect(res.body.prior_session_id).toBe("sess_h");
    expect(res.body.conversation_id).toBe("sess_h");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("selects the chain named by ?c= instead of the newest one", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_new",
        intent: "newer",
        result_summary: "n",
        created_at: new Date("2026-01-02T10:00:00Z"),
      }),
      fakeSession({
        id: "sess_old",
        intent: "older",
        result_summary: "o",
        created_at: new Date("2026-01-01T10:00:00Z"),
      }),
    ]);

    const newest = await request(makeApp(fakes)).get("/chat");
    expect(newest.body.conversation_id).toBe("sess_new");

    const picked = await request(makeApp(fakes)).get("/chat").query({ c: "sess_old" });
    expect(picked.body.conversation_id).toBe("sess_old");
    expect(picked.body.messages[0].content).toBe("older");
  });

  it("returns the empty state (not 404) for an unknown ?c=", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_a", result_summary: "a" }),
    ]);

    const res = await request(makeApp(fakes)).get("/chat").query({ c: "sess_nope" });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.prior_session_id).toBeNull();
    expect(res.body.conversation_id).toBeNull();
    expect(res.body.agent.id).toBe(AGENT);
  });

  it("keeps only the last 25 sessions of a long chain", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    const chain = Array.from({ length: 40 }, (_, i) =>
      fakeSession({
        id: `sess_${i}`,
        intent: `turn ${i}`,
        result_summary: `reply ${i}`,
        prior_session_id: i === 0 ? undefined : `sess_${i - 1}`,
        created_at: new Date(Date.UTC(2026, 0, 1, 10, i)),
      }),
    );
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue(chain);

    const res = await request(makeApp(fakes)).get("/chat");
    // 25 sessions × (user + agent) messages.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].content).toBe("turn 15");
    // Chain identity still comes from the full chain, not the window.
    expect(res.body.conversation_id).toBe("sess_0");
    expect(res.body.prior_session_id).toBe("sess_39");
  });

  it.each(["pending", "running"] as const)(
    "surfaces in_flight_session_id when the tail is %s",
    async (status) => {
      const fakes = makeFakes();
      withAgent(fakes);
      vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
        fakeSession({ id: "sess_live", intent: "working?", status }),
      ]);

      const res = await request(makeApp(fakes)).get("/chat");
      expect(res.body.in_flight_session_id).toBe("sess_live");
      // The user turn is there; the agent reply slot stays empty.
      expect(res.body.messages).toEqual([
        { id: "u_sess_live", role: "user", content: "working?" },
      ]);
    },
  );

  it("reports runtime_mismatch when the chain is pinned to another CLI", async () => {
    const fakes = makeFakes();
    withAgent(fakes, fakeAgent({ runtime_config: { type: "codex" } as Agent["runtime_config"] }));
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_pin", result_summary: "ok", runtime_id: "rt_1" }),
    ]);
    vi.mocked(fakes.runtimeRepo.findById).mockResolvedValue({
      id: "rt_1",
      cli: "claude",
    } as unknown as Runtime);

    const res = await request(makeApp(fakes)).get("/chat");
    expect(res.body.runtime_mismatch).toEqual({
      pinned_cli: "claude",
      current_cli: "codex",
    });
  });

  it("omits runtime_mismatch when the pinned CLI matches the agent's", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_pin", result_summary: "ok", runtime_id: "rt_1" }),
    ]);
    vi.mocked(fakes.runtimeRepo.findById).mockResolvedValue({
      id: "rt_1",
      cli: "claude",
    } as unknown as Runtime);

    const res = await request(makeApp(fakes)).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("omits runtime_mismatch when the tail has no runtime_id (no lookup at all)", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_free", result_summary: "ok" }),
    ]);

    const res = await request(makeApp(fakes)).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
    expect(fakes.runtimeRepo.findById).not.toHaveBeenCalled();
  });

  it.each([
    ["the runtime row is gone", undefined],
    ["the runtime's cli is unrecognized", { id: "rt_1", cli: "cursor" }],
  ])("omits runtime_mismatch when %s", async (_label, runtime) => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({ id: "sess_pin", result_summary: "ok", runtime_id: "rt_1" }),
    ]);
    vi.mocked(fakes.runtimeRepo.findById).mockResolvedValue(
      runtime as unknown as Runtime | undefined,
    );

    const res = await request(makeApp(fakes)).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("renders a system-wake turn as a `system` message with the summary only", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.listChatForAgent).mockResolvedValue([
      fakeSession({
        id: "sess_wake",
        intent: "<system-wake>task tsk_1 finished\n\nDecide next steps.</system-wake>",
        result_summary: "acknowledged",
      }),
    ]);

    const res = await request(makeApp(fakes)).get("/chat");
    expect(res.body.messages[0]).toEqual({
      id: "w_sess_wake",
      role: "system",
      content: "task tsk_1 finished",
      session_id: "sess_wake",
    });
  });
});

// ── POST /chat ───────────────────────────────────────────────────────────

/** Wire up a happy-path dispatch + resolve for the given final session. */
function primeTurn(fakes: Fakes, final: Partial<Session> = {}) {
  const dispatched = fakeSession({ id: "sess_dispatched", status: "pending" });
  vi.mocked(fakes.dispatchService.dispatchTask).mockResolvedValue({
    session: dispatched,
    runtime_id: "rt_1",
  });
  vi.mocked(fakes.chatResolver.register).mockResolvedValue(
    fakeSession({
      id: dispatched.id,
      status: "succeeded",
      result_summary: "done",
      ...final,
    }),
  );
  return dispatched;
}

describe("POST /chat", () => {
  it("403s a non-human caller", async () => {
    const fakes = makeFakes();
    const res = await request(makeApp(fakes, "agent")).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(403);
  });

  it.each([
    ["missing", {}],
    ["empty", { message: "" }],
    ["whitespace only", { message: "   \n " }],
    ["not a string", { message: 42 }],
  ])("400s when `message` is %s", async (_label, body) => {
    const fakes = makeFakes();
    withAgent(fakes);
    const res = await request(makeApp(fakes)).post("/chat").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
    expect(fakes.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const fakes = makeFakes();
    vi.mocked(fakes.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);
    const res = await request(makeApp(fakes)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
  });

  it("dispatches a fresh chat turn and returns the resolver's result", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    primeTurn(fakes, { result_summary: "the answer is 4" });

    const res = await request(makeApp(fakes)).post("/chat").send({ message: "  2+2  " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Alice's Team", hierarchy: "team" },
      session_id: "sess_dispatched",
      response: "the answer is 4",
      status: "succeeded",
      view_refs: [],
    });
    expect(res.body.replayed).toBeUndefined();
    expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      // Trimmed before dispatch.
      intent: "2+2",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
  });

  it("passes prior_session_id through as a chat_continuation resume reason", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    primeTurn(fakes);

    await request(makeApp(fakes))
      .post("/chat")
      .send({ message: "and then?", prior_session_id: "sess_prior" });

    expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_prior" },
      }),
    );
  });

  it("ignores a client session_id that isn't a well-formed sess_ id", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    primeTurn(fakes);

    await request(makeApp(fakes))
      .post("/chat")
      .send({ message: "hi", session_id: "not-a-session-id" });

    // No replay lookup, and nothing pinned on the dispatch.
    expect(fakes.sessionRepo.findById).not.toHaveBeenCalled();
    expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: undefined }),
    );
  });

  it("maps a failed turn through failureMessageFor rather than echoing the bare exit", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    primeTurn(fakes, {
      status: "failed",
      result_summary: undefined,
      error: "ENOENT: no such file",
    });

    const res = await request(makeApp(fakes)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.response).toBe("ENOENT: no such file");
  });

  it("extracts directives out of the summary into structured fields", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    primeTurn(fakes, {
      result_summary:
        'Here you go. <suggest_action label="Open the plan" prompt="show the plan" />',
    });

    const res = await request(makeApp(fakes)).post("/chat").send({ message: "hi" });
    expect(res.body.response).toBe("Here you go.");
    expect(res.body.suggested_actions).toEqual([
      { label: "Open the plan", prompt: "show the plan" },
    ]);
  });

  // ── idempotent replay ──────────────────────────────────────────────────

  const CLIENT_SID = "sess_abc123def456";

  it("replays a finished turn instead of dispatching again", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.findById).mockResolvedValue(
      fakeSession({
        id: CLIENT_SID,
        type: "chat",
        status: "succeeded",
        result_summary: "already answered",
      }),
    );

    const res = await request(makeApp(fakes))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.response).toBe("already answered");
    expect(res.body.session_id).toBe(CLIENT_SID);
    expect(fakes.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("409s when the replayed session is still running", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.findById).mockResolvedValue(
      fakeSession({ id: CLIENT_SID, type: "chat", status: "running" }),
    );

    const res = await request(makeApp(fakes))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(fakes.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the session id collides with another caller's session", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.findById).mockResolvedValue(
      fakeSession({ id: CLIENT_SID, type: "chat", agent_id: "agent_someone_else" }),
    );

    const res = await request(makeApp(fakes))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
    expect(fakes.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["the row does not exist", undefined],
    ["the row is not a chat session", { type: "task" as const }],
  ])("falls through to a live dispatch when %s", async (_label, existing) => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.findById).mockResolvedValue(
      existing ? fakeSession({ id: CLIENT_SID, ...existing }) : undefined,
    );
    primeTurn(fakes);

    const res = await request(makeApp(fakes))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(200);
    expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: CLIENT_SID }),
    );
  });

  it("falls through and re-dispatches a pending row under the same id", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.sessionRepo.findById).mockResolvedValue(
      fakeSession({ id: CLIENT_SID, type: "chat", status: "pending" }),
    );
    primeTurn(fakes);

    const res = await request(makeApp(fakes))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });

    expect(res.status).toBe(200);
    expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: CLIENT_SID }),
    );
  });

  // ── rate limit / offline / failure ─────────────────────────────────────

  it("429s a second concurrent turn for the same person, with Retry-After", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    primeTurn(fakes);
    // Stand in for a turn already in flight for this person. Holding a
    // real request open would mean an un-resolvable resolver promise;
    // taking the slot directly reaches the same branch deterministically.
    const held = fakes.rateLimiter.acquire(PERSON);
    expect(held.ok).toBe(true);

    const app = makeApp(fakes);
    const res = await request(app).post("/chat").send({ message: "second" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("turn_in_flight");
    expect(res.body.retry_after_ms).toBe(1000);
    expect(res.headers["retry-after"]).toBe("1");
    expect(fakes.dispatchService.dispatchTask).not.toHaveBeenCalled();

    // Releasing it lets the next turn straight through.
    if (held.ok) held.release();
    expect((await request(app).post("/chat").send({ message: "third" })).status).toBe(200);
  });

  it("429s with rate_limited once the sliding window is full", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    // One turn per 60s window; the first POST spends it.
    fakes.rateLimiter = new ChatRateLimiter({ maxPerWindow: 1 });
    primeTurn(fakes);

    const app = makeApp(fakes);
    expect((await request(app).post("/chat").send({ message: "one" })).status).toBe(200);

    const res = await request(app).post("/chat").send({ message: "two" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.body.retry_after_ms).toBeGreaterThan(0);
  });

  it("503s when the session is daemon-bound but the daemon is offline", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    primeTurn(fakes);
    vi.mocked(fakes.hub.isOnline).mockReturnValue(false);

    const res = await request(makeApp(fakes)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(fakes.chatResolver.register).not.toHaveBeenCalled();
  });

  it("does not check the hub for a null-runtime (executor fallback) dispatch", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.dispatchService.dispatchTask).mockResolvedValue({
      session: fakeSession({ id: "sess_exec", status: "pending" }),
      runtime_id: null,
    });
    vi.mocked(fakes.chatResolver.register).mockResolvedValue(
      fakeSession({ id: "sess_exec", status: "succeeded", result_summary: "ok" }),
    );

    const res = await request(makeApp(fakes)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(fakes.hub.isOnline).not.toHaveBeenCalled();
  });

  it("releases the rate-limit slot and 500s when dispatch throws", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.dispatchService.dispatchTask).mockRejectedValue(
      new Error("DispatchService: agent not found"),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const app = makeApp(fakes);
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");

    // Slot was released — the next turn is not blocked as "concurrent".
    primeTurn(fakes);
    expect((await request(app).post("/chat").send({ message: "again" })).status).toBe(200);
    spy.mockRestore();
  });

  it("504s when the resolver times out", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.dispatchService.dispatchTask).mockResolvedValue({
      session: fakeSession({ id: "sess_slow", status: "pending" }),
      runtime_id: "rt_1",
    });
    vi.mocked(fakes.chatResolver.register).mockRejectedValue(
      new Error("chat resolver timeout (90000ms) for sess_slow"),
    );

    const res = await request(makeApp(fakes)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(504);
    expect(res.body.error).toBe("chat_turn_timeout");
    expect(res.body.timeout_ms).toBe(90_000);
  });

  it("500s when the resolver rejects for any other reason", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.dispatchService.dispatchTask).mockResolvedValue({
      session: fakeSession({ id: "sess_x", status: "pending" }),
      runtime_id: "rt_1",
    });
    vi.mocked(fakes.chatResolver.register).mockRejectedValue(
      new Error("chat resolver already registered for sess_x"),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(makeApp(fakes)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    spy.mockRestore();
  });

  // ── onboarding flip ────────────────────────────────────────────────────

  it("stamps onboarding_completed_at on the first successful turn", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.personRepo.findById).mockResolvedValue(fakePerson());
    primeTurn(fakes);

    const res = await request(makeApp(fakes)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(fakes.personRepo.update).toHaveBeenCalledWith(PERSON, {
      onboarding_completed_at: expect.any(Date),
    });
  });

  it("does not re-stamp for an already-onboarded person", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    primeTurn(fakes);

    await request(makeApp(fakes)).post("/chat").send({ message: "hi" });
    expect(fakes.personRepo.update).not.toHaveBeenCalled();
  });

  it("does not stamp when the first turn fails", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.personRepo.findById).mockResolvedValue(fakePerson());
    primeTurn(fakes, { status: "failed", result_summary: undefined, error: "nope" });

    await request(makeApp(fakes)).post("/chat").send({ message: "hi" });
    expect(fakes.personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers when the onboarding stamp write fails", async () => {
    const fakes = makeFakes();
    withAgent(fakes);
    vi.mocked(fakes.personRepo.findById).mockResolvedValue(fakePerson());
    vi.mocked(fakes.personRepo.update).mockRejectedValue(new Error("write conflict"));
    primeTurn(fakes, { result_summary: "answered anyway" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(makeApp(fakes)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe("answered anyway");
    // Let the fire-and-forget rejection land before restoring the spy.
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
