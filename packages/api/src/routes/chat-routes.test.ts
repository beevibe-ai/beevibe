/**
 * Tests for the `createChatRouter` surface — the four routes and the
 * three module-private helpers they reach through
 * (`detectRuntimeMismatch`, `toChatTurnResponse`, `tryReplay`).
 *
 * `chat-internals.test.ts` already covers the exported pure functions
 * (`groupIntoConversations`, `failureMessageFor`, `chainToMessages`)
 * and `chat-rate-limit.test.ts` covers the limiter in isolation, so
 * neither is re-tested here. What was uncovered is everything from
 * `detectRuntimeMismatch` down: ~320 statements of routing, auth
 * gating, replay, rate-limit mapping and dispatch error handling.
 *
 * Every collaborator is injected, so the router mounts on a bare
 * Express app against vitest fakes — no database, no daemon, no CLI.
 * `processResponse` / `failureMessageFor` / `groupIntoConversations`
 * run for real: the point is the route's composition, not a re-mock
 * of logic that already has its own tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { json, type RequestHandler } from "express";
import request from "supertest";
import { createChatRouter, type ChatRoutesDeps } from "./chat.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";

const PERSON = "per_alice";
const AGENT = { id: "agt_team", name: "Team", hierarchy_level: "team" } as const;

/** Auth middleware stand-in — attaches whatever caller the test wants. */
function callerAs(caller: unknown): RequestHandler {
  return (req, _res, next) => {
    if (caller !== null) (req as { caller?: unknown }).caller = caller;
    next();
  };
}

const humanCaller = { source: "human", personId: PERSON };
const agentCaller = { source: "agent", personId: PERSON, agentId: "agt_1" };

function agentRow(over: Record<string, unknown> = {}) {
  return {
    ...AGENT,
    runtime_config: { type: "claude_code" },
    ...over,
  };
}

function chatRow(over: Record<string, unknown> & { id: string }) {
  return {
    intent: "hello",
    status: "succeeded",
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

interface Stubs {
  findTopLevelForOwner: ReturnType<typeof vi.fn>;
  personFindById: ReturnType<typeof vi.fn>;
  personUpdate: ReturnType<typeof vi.fn>;
  runtimeFindById: ReturnType<typeof vi.fn>;
  listChatForAgent: ReturnType<typeof vi.fn>;
  softDeleteChatChain: ReturnType<typeof vi.fn>;
  sessionFindById: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  isOnline: ReturnType<typeof vi.fn>;
}

function makeApp(
  opts: {
    caller?: unknown;
    rateLimiter?: ChatRateLimiter;
  } = {},
): { app: express.Express } & Stubs {
  const stubs: Stubs = {
    findTopLevelForOwner: vi.fn().mockResolvedValue(agentRow()),
    personFindById: vi.fn().mockResolvedValue({
      id: PERSON,
      onboarding_completed_at: new Date("2026-01-01T00:00:00Z"),
    }),
    personUpdate: vi.fn().mockResolvedValue(undefined),
    runtimeFindById: vi.fn().mockResolvedValue(undefined),
    listChatForAgent: vi.fn().mockResolvedValue([]),
    softDeleteChatChain: vi.fn().mockResolvedValue(0),
    sessionFindById: vi.fn().mockResolvedValue(undefined),
    dispatchTask: vi.fn().mockResolvedValue({
      session: { id: "sess_aaaaaaaaaaaa" },
      runtime_id: null,
    }),
    register: vi.fn().mockResolvedValue({
      id: "sess_aaaaaaaaaaaa",
      status: "succeeded",
      result_summary: "done",
      error: null,
    }),
    isOnline: vi.fn().mockReturnValue(true),
  };

  const deps: ChatRoutesDeps = {
    authMiddleware: callerAs(opts.caller === undefined ? humanCaller : opts.caller),
    agentRepo: { findTopLevelForOwner: stubs.findTopLevelForOwner } as never,
    personRepo: {
      findById: stubs.personFindById,
      update: stubs.personUpdate,
    } as never,
    runtimeRepo: { findById: stubs.runtimeFindById } as never,
    sessionRepo: {
      listChatForAgent: stubs.listChatForAgent,
      softDeleteChatChain: stubs.softDeleteChatChain,
      findById: stubs.sessionFindById,
    } as never,
    dispatchService: { dispatchTask: stubs.dispatchTask } as never,
    chatResolver: { register: stubs.register } as never,
    hub: { isOnline: stubs.isOnline } as never,
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
  };

  const app = express();
  app.use(json());
  app.use("/chat", createChatRouter(deps));
  return { app, ...stubs };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /chat/conversations", () => {
  it("rejects a non-human caller with 403", async () => {
    const { app, findTopLevelForOwner } = makeApp({ caller: agentCaller });
    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
    expect(findTopLevelForOwner).not.toHaveBeenCalled();
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const { app, findTopLevelForOwner, listChatForAgent } = makeApp();
    findTopLevelForOwner.mockResolvedValue(undefined);
    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain with title, turn count and tail preview", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_h", intent: "first question", result_summary: "a" }),
      chatRow({
        id: "sess_t",
        prior_session_id: "sess_h",
        intent: "follow up",
        result_summary: "the   tail\nreply",
        created_at: new Date("2026-01-02T00:00:00Z"),
      }),
    ]);
    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_h",
        title: "first question",
        turn_count: 2,
        last_at: "2026-01-02T00:00:00.000Z",
        // whitespace collapsed by previewOf
        last_preview: "the tail reply",
      },
    ]);
  });

  it("truncates a long first-turn intent to the thread-title max", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([chatRow({ id: "sess_h", intent: "x".repeat(200) })]);
    const res = await request(app).get("/chat/conversations");
    expect(res.body.conversations[0].title.length).toBeLessThanOrEqual(80);
  });

  it("previews the error text when a turn has no result summary", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_h", status: "failed", error: "boom happened" }),
    ]);
    const res = await request(app).get("/chat/conversations");
    expect(res.body.conversations[0].last_preview).toBe("boom happened");
  });

  it("falls back to the intent when there is neither summary nor error", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([chatRow({ id: "sess_h", intent: "just the intent" })]);
    expect((await request(app).get("/chat/conversations")).body.conversations[0].last_preview).toBe(
      "just the intent",
    );
  });

  it("ellipsizes a preview longer than the preview budget", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_h", result_summary: "y".repeat(300) }),
    ]);
    const preview = (await request(app).get("/chat/conversations")).body.conversations[0]
      .last_preview;
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("caps the list at CONVERSATIONS_LIMIT chains", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => chatRow({ id: `sess_${i}` })),
    );
    const res = await request(app).get("/chat/conversations");
    expect(res.body.conversations).toHaveLength(50);
  });
});

describe("DELETE /chat/conversations/:headId", () => {
  it("rejects a non-human caller with 403", async () => {
    const { app } = makeApp({ caller: agentCaller });
    const res = await request(app).delete("/chat/conversations/sess_h");
    expect(res.status).toBe(403);
  });

  it("404s when the caller has no primary agent", async () => {
    const { app, findTopLevelForOwner, softDeleteChatChain } = makeApp();
    findTopLevelForOwner.mockResolvedValue(undefined);
    const res = await request(app).delete("/chat/conversations/sess_h");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
    expect(softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const { app, softDeleteChatChain } = makeApp();
    softDeleteChatChain.mockResolvedValue(3);
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(softDeleteChatChain).toHaveBeenCalledWith("sess_head", AGENT.id);
  });

  it("is idempotent — a chain already deleted still returns ok", async () => {
    const { app, softDeleteChatChain } = makeApp();
    softDeleteChatChain.mockResolvedValue(0);
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("maps a repo throw to a 500 with a request id", async () => {
    const { app, softDeleteChatChain } = makeApp();
    softDeleteChatChain.mockRejectedValue(new Error("db down"));
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // Internal detail stays server-side.
    expect(JSON.stringify(res.body)).not.toContain("db down");
  });
});

describe("GET /chat", () => {
  it("rejects a non-human caller with 403", async () => {
    const { app } = makeApp({ caller: agentCaller });
    expect((await request(app).get("/chat")).status).toBe(403);
  });

  it("returns a null agent and empty history when none is provisioned", async () => {
    const { app, findTopLevelForOwner } = makeApp();
    findTopLevelForOwner.mockResolvedValue(undefined);
    const res = await request(app).get("/chat");
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns the empty state when the agent has no chat sessions yet", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/chat");
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT.id, name: AGENT.name, hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("rehydrates the most recent chain when no ?c is given", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_old", intent: "older", result_summary: "old reply" }),
      chatRow({
        id: "sess_new",
        intent: "newer",
        result_summary: "new reply",
        created_at: new Date("2026-02-01T00:00:00Z"),
      }),
    ]);
    const res = await request(app).get("/chat");
    expect(res.body.conversation_id).toBe("sess_new");
    expect(res.body.prior_session_id).toBe("sess_new");
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "newer",
      "new reply",
    ]);
  });

  it("selects the chain named by ?c", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_old", intent: "older", result_summary: "old reply" }),
      chatRow({
        id: "sess_new",
        intent: "newer",
        created_at: new Date("2026-02-01T00:00:00Z"),
      }),
    ]);
    const res = await request(app).get("/chat").query({ c: "sess_old" });
    expect(res.body.conversation_id).toBe("sess_old");
    expect(res.body.messages[0].content).toBe("older");
  });

  it("returns the empty state (not 404) for an unknown ?c", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([chatRow({ id: "sess_a" })]);
    const res = await request(app).get("/chat").query({ c: "sess_missing" });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
    expect(res.body.agent).toMatchObject({ id: AGENT.id });
  });

  it("ignores a non-string ?c and falls back to the most recent chain", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([chatRow({ id: "sess_a", intent: "only" })]);
    const res = await request(app).get("/chat?c[]=x&c[]=y");
    expect(res.body.conversation_id).toBe("sess_a");
  });

  it("truncates history to the last HISTORY_LIMIT/2 turns of the chain", async () => {
    const { app, listChatForAgent } = makeApp();
    // 30-turn chain: head + 29 continuations, each 1 user + 1 agent message.
    const rows = Array.from({ length: 30 }, (_, i) =>
      chatRow({
        id: `sess_${i}`,
        ...(i > 0 ? { prior_session_id: `sess_${i - 1}` } : {}),
        intent: `turn ${i}`,
        result_summary: `reply ${i}`,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, i)),
      }),
    );
    listChatForAgent.mockResolvedValue(rows);
    const res = await request(app).get("/chat");
    // 25 sessions kept × 2 messages each.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].content).toBe("turn 5");
    expect(res.body.prior_session_id).toBe("sess_29");
  });

  it("surfaces in_flight_session_id while the tail turn is still running", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_a", intent: "q", status: "running", result_summary: undefined }),
    ]);
    const res = await request(app).get("/chat");
    expect(res.body.in_flight_session_id).toBe("sess_a");
    // chainToMessages leaves the agent reply slot empty for in-flight turns.
    expect(res.body.messages).toEqual([{ id: "u_sess_a", role: "user", content: "q" }]);
  });

  it("omits in_flight_session_id once the tail turn is terminal", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([chatRow({ id: "sess_a", result_summary: "r" })]);
    const res = await request(app).get("/chat");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("reports a runtime mismatch when the chain is pinned to another CLI", async () => {
    const { app, listChatForAgent, runtimeFindById } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_a", runtime_id: "rt_1", result_summary: "r" }),
    ]);
    runtimeFindById.mockResolvedValue({ id: "rt_1", cli: "codex" });
    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toEqual({
      pinned_cli: "codex",
      current_cli: "claude_code",
    });
    expect(runtimeFindById).toHaveBeenCalledWith("rt_1");
  });

  it("reports no mismatch when the pinned CLI equals the agent's current CLI", async () => {
    const { app, listChatForAgent, runtimeFindById } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_a", runtime_id: "rt_1", result_summary: "r" }),
    ]);
    runtimeFindById.mockResolvedValue({ id: "rt_1", cli: "claude_code" });
    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("skips the runtime lookup entirely when the tail session has no runtime_id", async () => {
    const { app, listChatForAgent, runtimeFindById } = makeApp();
    listChatForAgent.mockResolvedValue([chatRow({ id: "sess_a", result_summary: "r" })]);
    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
    expect(runtimeFindById).not.toHaveBeenCalled();
  });

  it("reports no mismatch when the pinned runtime row is gone", async () => {
    const { app, listChatForAgent, runtimeFindById } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_a", runtime_id: "rt_gone", result_summary: "r" }),
    ]);
    runtimeFindById.mockResolvedValue(undefined);
    expect((await request(app).get("/chat")).body.runtime_mismatch).toBeUndefined();
  });

  it("reports no mismatch when the pinned runtime's cli is not a known CLI", async () => {
    const { app, listChatForAgent, runtimeFindById } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_a", runtime_id: "rt_1", result_summary: "r" }),
    ]);
    runtimeFindById.mockResolvedValue({ id: "rt_1", cli: "some_future_cli" });
    expect((await request(app).get("/chat")).body.runtime_mismatch).toBeUndefined();
  });
});

describe("POST /chat — validation and agent resolution", () => {
  it("rejects a non-human caller with 403", async () => {
    const { app } = makeApp({ caller: agentCaller });
    expect((await request(app).post("/chat").send({ message: "hi" })).status).toBe(403);
  });

  it("400s on a missing message", async () => {
    const { app, dispatchTask } = makeApp();
    const res = await request(app).post("/chat").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("400s on a whitespace-only message", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/chat").send({ message: "   \n  " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
  });

  it("400s on a non-string message", async () => {
    const { app } = makeApp();
    expect((await request(app).post("/chat").send({ message: 42 })).status).toBe(400);
  });

  it("404s when the caller has no primary agent", async () => {
    const { app, findTopLevelForOwner, dispatchTask } = makeApp();
    findTopLevelForOwner.mockResolvedValue(undefined);
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("trims the message before dispatching it", async () => {
    const { app, dispatchTask } = makeApp();
    await request(app).post("/chat").send({ message: "  hello  " });
    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "hello", type: "chat" }),
    );
  });
});

describe("POST /chat — dispatch and resume reason", () => {
  it("dispatches a fresh turn when no prior_session_id is given", async () => {
    const { app, dispatchTask } = makeApp();
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT.id,
      intent: "hi",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
  });

  it("passes a chat_continuation reason when prior_session_id is given", async () => {
    const { app, dispatchTask } = makeApp();
    await request(app)
      .post("/chat")
      .send({ message: "hi", prior_session_id: "sess_prior000000" });
    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_prior000000" },
      }),
    );
  });

  it("ignores a non-string prior_session_id", async () => {
    const { app, dispatchTask } = makeApp();
    await request(app).post("/chat").send({ message: "hi", prior_session_id: 7 });
    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ reason: { kind: "fresh" } }),
    );
  });

  it("honors a well-formed caller session_id as the dispatch override", async () => {
    const { app, dispatchTask } = makeApp();
    await request(app).post("/chat").send({ message: "hi", session_id: "sess_abc123XYZ789" });
    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: "sess_abc123XYZ789" }),
    );
  });

  it("ignores a malformed caller session_id rather than failing the turn", async () => {
    const { app, dispatchTask, sessionFindById } = makeApp();
    await request(app).post("/chat").send({ message: "hi", session_id: "not-a-session" });
    expect(sessionFindById).not.toHaveBeenCalled();
    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: undefined }),
    );
  });

  it("maps a dispatch throw to a 500 and releases the rate-limit slot", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const { app, dispatchTask } = makeApp({ rateLimiter: limiter });
    dispatchTask.mockRejectedValue(new Error("dispatch exploded"));
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    // Slot released: a second turn is not blocked as "concurrent".
    const outcome = limiter.acquire(PERSON);
    expect(outcome.ok).toBe(true);
  });

  it("503s when the session is bound to a daemon that is offline", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const { app, dispatchTask, isOnline, register } = makeApp({ rateLimiter: limiter });
    dispatchTask.mockResolvedValue({
      session: { id: "sess_aaaaaaaaaaaa" },
      runtime_id: "rt_1",
    });
    isOnline.mockReturnValue(false);
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(register).not.toHaveBeenCalled();
    expect(limiter.acquire(PERSON).ok).toBe(true);
  });

  it("proceeds for a null-runtime session without consulting the hub", async () => {
    const { app, isOnline, register } = makeApp();
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(isOnline).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith("sess_aaaaaaaaaaaa", 90_000);
  });

  it("proceeds when the bound daemon is online", async () => {
    const { app, dispatchTask, isOnline } = makeApp();
    dispatchTask.mockResolvedValue({
      session: { id: "sess_aaaaaaaaaaaa" },
      runtime_id: "rt_1",
    });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(isOnline).toHaveBeenCalledWith("rt_1");
  });
});

describe("POST /chat — response body", () => {
  it("returns the processed visible response on success", async () => {
    const { app, register } = makeApp();
    register.mockResolvedValue({
      id: "sess_aaaaaaaaaaaa",
      status: "succeeded",
      result_summary: "all good",
      error: null,
    });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT.id, name: AGENT.name, hierarchy: "team" },
      session_id: "sess_aaaaaaaaaaaa",
      response: "all good",
      status: "succeeded",
      view_refs: [],
    });
    expect(res.body.replayed).toBeUndefined();
  });

  it("passes directive payloads from the summary through to the client", async () => {
    const { app, register } = makeApp();
    register.mockResolvedValue({
      id: "sess_aaaaaaaaaaaa",
      status: "succeeded",
      result_summary:
        "here you go\n" +
        '<open_view path="/tasks" label="Tasks" />\n' +
        '<suggest_action label="Do it" prompt="do it" />',
      error: null,
    });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.body.open_view).toEqual({ path: "/tasks", label: "Tasks" });
    expect(res.body.suggested_actions).toEqual([{ label: "Do it", prompt: "do it" }]);
    expect(res.body.response).toBe("here you go");
  });

  it("uses the friendly failure message for a failed turn", async () => {
    const { app, register } = makeApp();
    register.mockResolvedValue({
      id: "sess_aaaaaaaaaaaa",
      status: "failed",
      result_summary: null,
      error: "the agent could not reach the repo",
    });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.response).toBe("the agent could not reach the repo");
  });

  it("falls back to the session error when a non-failed turn has no summary", async () => {
    const { app, register } = makeApp();
    register.mockResolvedValue({
      id: "sess_aaaaaaaaaaaa",
      status: "cancelled",
      result_summary: null,
      error: "cancelled by user",
    });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.body.response).toBe("cancelled by user");
  });

  it("returns an empty response when there is neither summary nor error", async () => {
    const { app, register } = makeApp();
    register.mockResolvedValue({
      id: "sess_aaaaaaaaaaaa",
      status: "cancelled",
      result_summary: null,
      error: null,
    });
    expect((await request(app).post("/chat").send({ message: "hi" })).body.response).toBe("");
  });
});

describe("POST /chat — onboarding flag", () => {
  it("flips onboarding_completed_at on the first successful turn", async () => {
    const { app, personFindById, personUpdate } = makeApp();
    personFindById.mockResolvedValue({ id: PERSON, onboarding_completed_at: null });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(personUpdate).toHaveBeenCalledWith(PERSON, {
      onboarding_completed_at: expect.any(Date),
    });
  });

  it("does not flip the flag when the first turn fails", async () => {
    const { app, personFindById, personUpdate, register } = makeApp();
    personFindById.mockResolvedValue({ id: PERSON, onboarding_completed_at: null });
    register.mockResolvedValue({
      id: "sess_aaaaaaaaaaaa",
      status: "failed",
      result_summary: null,
      error: "nope",
    });
    await request(app).post("/chat").send({ message: "hi" });
    expect(personUpdate).not.toHaveBeenCalled();
  });

  it("does not re-flip the flag for an already-onboarded person", async () => {
    const { app, personUpdate } = makeApp();
    await request(app).post("/chat").send({ message: "hi" });
    expect(personUpdate).not.toHaveBeenCalled();
  });

  it("still answers the turn when the onboarding write rejects", async () => {
    const { app, personFindById, personUpdate } = makeApp();
    personFindById.mockResolvedValue({ id: PERSON, onboarding_completed_at: null });
    personUpdate.mockRejectedValue(new Error("write failed"));
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("treats a missing person row as not-yet-onboarded", async () => {
    const { app, personFindById, personUpdate } = makeApp();
    personFindById.mockResolvedValue(undefined);
    await request(app).post("/chat").send({ message: "hi" });
    expect(personUpdate).toHaveBeenCalled();
  });
});

describe("POST /chat — idempotent replay", () => {
  const SID = "sess_abc123XYZ789";

  it("replays a succeeded session instead of dispatching again", async () => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue({
      id: SID,
      type: "chat",
      agent_id: AGENT.id,
      status: "succeeded",
      result_summary: "cached answer",
      error: null,
    });
    const res = await request(app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      session_id: SID,
      response: "cached answer",
      status: "succeeded",
      replayed: true,
    });
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed session with the friendly failure message", async () => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue({
      id: SID,
      type: "chat",
      agent_id: AGENT.id,
      status: "failed",
      result_summary: null,
      error: "it broke",
    });
    const res = await request(app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "failed", response: "it broke", replayed: true });
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("409s when the session is still running", async () => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue({
      id: SID,
      type: "chat",
      agent_id: AGENT.id,
      status: "running",
    });
    const res = await request(app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the session belongs to a different agent", async () => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue({
      id: SID,
      type: "chat",
      agent_id: "agt_someone_else",
      status: "succeeded",
    });
    const res = await request(app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("falls through to dispatch when the row does not exist", async () => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue(undefined);
    const res = await request(app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(200);
    expect(dispatchTask).toHaveBeenCalled();
  });

  it("falls through to dispatch when the row is not a chat session", async () => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue({
      id: SID,
      type: "task",
      agent_id: AGENT.id,
      status: "succeeded",
    });
    const res = await request(app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(200);
    expect(dispatchTask).toHaveBeenCalled();
  });

  it("falls through to dispatch for a pending row (skip decision)", async () => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue({
      id: SID,
      type: "chat",
      agent_id: AGENT.id,
      status: "pending",
    });
    const res = await request(app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(200);
    expect(dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: SID }),
    );
  });
});

describe("POST /chat — rate limiting", () => {
  it("429s with turn_in_flight once the concurrent slot is taken", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    limiter.acquire(PERSON); // never released — stands in for a live turn
    const { app, dispatchTask } = makeApp({ rateLimiter: limiter });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("turn_in_flight");
    expect(res.body.message).toMatch(/previous chat turn/);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.body.retry_after_ms).toBeGreaterThan(0);
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("429s with rate_limited once the sliding window is full", async () => {
    // Frozen clock: the window must not slide under the test.
    const now = 1_000_000;
    const limiter = new ChatRateLimiter({
      maxConcurrent: 10,
      maxPerWindow: 2,
      windowMs: 60_000,
      now: () => now,
    });
    const { app, dispatchTask } = makeApp({ rateLimiter: limiter });
    for (let i = 0; i < 2; i++) {
      const ok = await request(app).post("/chat").send({ message: "hi" });
      expect(ok.status).toBe(200);
    }
    dispatchTask.mockClear();
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.body.message).toMatch(/Too many chat turns/);
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("releases the slot after a successful turn so the next one proceeds", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const { app } = makeApp({ rateLimiter: limiter });
    expect((await request(app).post("/chat").send({ message: "one" })).status).toBe(200);
    expect((await request(app).post("/chat").send({ message: "two" })).status).toBe(200);
  });

  it("checks the limiter only after the replay short-circuit", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    limiter.acquire(PERSON);
    const { app, sessionFindById } = makeApp({ rateLimiter: limiter });
    sessionFindById.mockResolvedValue({
      id: "sess_abc123XYZ789",
      type: "chat",
      agent_id: AGENT.id,
      status: "succeeded",
      result_summary: "cached",
      error: null,
    });
    // A replay costs nothing, so it must not be rejected by the limiter.
    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abc123XYZ789" });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
  });
});

describe("POST /chat — resolver outcomes", () => {
  it("504s when the resolver times out", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const { app, register } = makeApp({ rateLimiter: limiter });
    register.mockRejectedValue(new Error("chat turn timeout after 90000ms"));
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      error: "chat_turn_timeout",
      timeout_ms: 90_000,
    });
    // The slot is released in `finally`, even on the timeout path.
    expect(limiter.acquire(PERSON).ok).toBe(true);
  });

  it("500s on a non-timeout resolver rejection", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const { app, register } = makeApp({ rateLimiter: limiter });
    register.mockRejectedValue(new Error("resolver already registered"));
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(limiter.acquire(PERSON).ok).toBe(true);
  });

  it("500s when the resolver rejects with a non-Error value", async () => {
    const { app, register } = makeApp();
    register.mockRejectedValue("just a string");
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });
});
