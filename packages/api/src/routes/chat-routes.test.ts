/**
 * Tests for the /chat router itself.
 *
 * `chat-internals.test.ts` covers the exported pure helpers
 * (groupIntoConversations, chainToMessages, failureMessageFor). This
 * file covers the four routes and the private helpers only reachable
 * through them — previewOf, toChatTurnResponse, tryReplay,
 * detectRuntimeMismatch, extractWakeSummary and handleError.
 *
 * Every collaborator is injected, so the router mounts on a bare
 * Express app with stubs — no database, no daemon, no CLI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { json, type RequestHandler } from "express";
import request from "supertest";
import { createChatRouter, type ChatRoutesDeps } from "./chat.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";

const PERSON = "per_alice";
const AGENT = {
  id: "agt_1",
  name: "Scout",
  hierarchy_level: "team",
  runtime_config: { type: "claude_code" },
};

const humanCaller = { source: "human", personId: PERSON };
const agentCaller = { source: "agent", personId: PERSON, agentId: "agt_1" };

function callerAs(caller: unknown): RequestHandler {
  return (req, _res, next) => {
    if (caller !== null) (req as { caller?: unknown }).caller = caller;
    next();
  };
}

interface Stubs {
  findTopLevelForOwner: ReturnType<typeof vi.fn>;
  listChatForAgent: ReturnType<typeof vi.fn>;
  softDeleteChatChain: ReturnType<typeof vi.fn>;
  sessionFindById: ReturnType<typeof vi.fn>;
  personFindById: ReturnType<typeof vi.fn>;
  personUpdate: ReturnType<typeof vi.fn>;
  runtimeFindById: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  isOnline: ReturnType<typeof vi.fn>;
}

function makeApp(
  opts: { caller?: unknown; rateLimiter?: ChatRateLimiter } = {},
): { app: express.Express } & Stubs {
  const stubs: Stubs = {
    findTopLevelForOwner: vi.fn(async () => AGENT),
    listChatForAgent: vi.fn(async () => []),
    softDeleteChatChain: vi.fn(async () => 0),
    sessionFindById: vi.fn(async () => undefined),
    personFindById: vi.fn(async () => ({
      id: PERSON,
      onboarding_completed_at: new Date("2026-01-01T00:00:00Z"),
    })),
    personUpdate: vi.fn(async () => undefined),
    runtimeFindById: vi.fn(async () => undefined),
    dispatchTask: vi.fn(async () => ({
      session: { id: "sess_dispatched1" },
      runtime_id: undefined,
    })),
    register: vi.fn(async () => ({
      id: "sess_dispatched1",
      status: "succeeded",
      result_summary: "Done.",
      error: null,
    })),
    isOnline: vi.fn(() => true),
  };

  const deps = {
    authMiddleware: callerAs(opts.caller === undefined ? humanCaller : opts.caller),
    agentRepo: { findTopLevelForOwner: stubs.findTopLevelForOwner },
    personRepo: { findById: stubs.personFindById, update: stubs.personUpdate },
    runtimeRepo: { findById: stubs.runtimeFindById },
    sessionRepo: {
      listChatForAgent: stubs.listChatForAgent,
      softDeleteChatChain: stubs.softDeleteChatChain,
      findById: stubs.sessionFindById,
    },
    dispatchService: { dispatchTask: stubs.dispatchTask },
    chatResolver: { register: stubs.register },
    hub: { isOnline: stubs.isOnline },
    rateLimiter: opts.rateLimiter,
  } as unknown as ChatRoutesDeps;

  const app = express();
  app.use(json());
  app.use("/chat", createChatRouter(deps));
  return { app, ...stubs };
}

/** A chat session row as listChatForAgent returns it. */
function session(
  id: string,
  over: Partial<{
    prior_session_id: string;
    intent: string;
    result_summary: string;
    status: string;
    error: string;
    created_at: Date;
    runtime_id: string;
  }> = {},
) {
  return {
    id,
    intent: `intent for ${id}`,
    status: "succeeded",
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

describe("GET /chat/conversations", () => {
  it("rejects a non-human caller", async () => {
    const { app } = makeApp({ caller: agentCaller });
    const res = await request(app).get("/chat/conversations");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "human_required" });
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const { app, findTopLevelForOwner, listChatForAgent } = makeApp();
    findTopLevelForOwner.mockResolvedValue(null);

    const res = await request(app).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain with its title, turn count and last activity", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      session("sess_a", { intent: "first question" }),
      session("sess_b", {
        prior_session_id: "sess_a",
        result_summary: "the answer",
        created_at: new Date("2026-01-02T00:00:00Z"),
      }),
    ]);

    const res = await request(app).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_a",
        title: "first question",
        turn_count: 2,
        last_at: "2026-01-02T00:00:00.000Z",
        last_preview: "the answer",
      },
    ]);
  });

  it("scopes the listing to the caller's own agent", async () => {
    const { app, findTopLevelForOwner, listChatForAgent } = makeApp();
    await request(app).get("/chat/conversations");

    expect(findTopLevelForOwner).toHaveBeenCalledWith(PERSON);
    expect(listChatForAgent).toHaveBeenCalledWith("agt_1", 400);
  });

  it("caps the response at 50 conversations even when more chains exist", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => session(`sess_${i}`)),
    );

    const res = await request(app).get("/chat/conversations");

    expect(res.body.conversations).toHaveLength(50);
  });

  describe("last_preview", () => {
    it("falls back to the error when there is no summary", async () => {
      const { app, listChatForAgent } = makeApp();
      listChatForAgent.mockResolvedValue([
        session("sess_a", { status: "failed", error: "it broke" }),
      ]);

      const res = await request(app).get("/chat/conversations");
      expect(res.body.conversations[0].last_preview).toBe("it broke");
    });

    it("falls back to the intent when there is neither summary nor error", async () => {
      const { app, listChatForAgent } = makeApp();
      listChatForAgent.mockResolvedValue([session("sess_a", { intent: "just asking" })]);

      const res = await request(app).get("/chat/conversations");
      expect(res.body.conversations[0].last_preview).toBe("just asking");
    });

    it("collapses whitespace to a single line", async () => {
      const { app, listChatForAgent } = makeApp();
      listChatForAgent.mockResolvedValue([
        session("sess_a", { result_summary: "line one\n\n  line two" }),
      ]);

      const res = await request(app).get("/chat/conversations");
      expect(res.body.conversations[0].last_preview).toBe("line one line two");
    });

    it("truncates a long preview to 140 chars with an ellipsis", async () => {
      const { app, listChatForAgent } = makeApp();
      listChatForAgent.mockResolvedValue([
        session("sess_a", { result_summary: "z".repeat(300) }),
      ]);

      const res = await request(app).get("/chat/conversations");
      const preview = res.body.conversations[0].last_preview as string;

      expect(preview).toHaveLength(140);
      expect(preview.endsWith("…")).toBe(true);
    });
  });
});

describe("DELETE /chat/conversations/:headId", () => {
  it("rejects a non-human caller", async () => {
    const { app } = makeApp({ caller: agentCaller });
    const res = await request(app).delete("/chat/conversations/sess_a");

    expect(res.status).toBe(403);
  });

  it("404s when the caller has no primary agent", async () => {
    const { app, findTopLevelForOwner, softDeleteChatChain } = makeApp();
    findTopLevelForOwner.mockResolvedValue(null);

    const res = await request(app).delete("/chat/conversations/sess_a");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "agent_not_found" });
    expect(softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const { app, softDeleteChatChain } = makeApp();
    softDeleteChatChain.mockResolvedValue(3);

    const res = await request(app).delete("/chat/conversations/sess_a");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(softDeleteChatChain).toHaveBeenCalledWith("sess_a", "agt_1");
  });

  it("is idempotent — re-deleting reports zero rows, not an error", async () => {
    const { app, softDeleteChatChain } = makeApp();
    softDeleteChatChain.mockResolvedValue(0);

    const res = await request(app).delete("/chat/conversations/sess_a");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("maps a repository throw to a 500 carrying a request_id", async () => {
    const { app, softDeleteChatChain } = makeApp();
    softDeleteChatChain.mockRejectedValue(new Error("pg down"));

    const res = await request(app).delete("/chat/conversations/sess_a");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // The internal detail stays in the log, not the response body.
    expect(JSON.stringify(res.body)).not.toContain("pg down");
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("GET /chat", () => {
  it("rejects a non-human caller", async () => {
    const { app } = makeApp({ caller: agentCaller });
    expect((await request(app).get("/chat")).status).toBe(403);
  });

  it("returns a null agent and empty history when none is provisioned", async () => {
    const { app, findTopLevelForOwner } = makeApp();
    findTopLevelForOwner.mockResolvedValue(null);

    const res = await request(app).get("/chat");

    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns the agent with an empty history when there are no chats", async () => {
    const { app } = makeApp();
    const res = await request(app).get("/chat");

    expect(res.body).toEqual({
      ok: true,
      agent: { id: "agt_1", name: "Scout", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("rehydrates the most recent chain as user/agent messages", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      session("sess_a", { intent: "hello", result_summary: "hi there" }),
    ]);

    const res = await request(app).get("/chat");

    expect(res.body.messages).toEqual([
      { id: "u_sess_a", role: "user", content: "hello" },
      { id: "a_sess_a", role: "agent", content: "hi there", session_id: "sess_a" },
    ]);
    expect(res.body.prior_session_id).toBe("sess_a");
    expect(res.body.conversation_id).toBe("sess_a");
  });

  it("selects the chain named by ?c=", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      session("sess_new", { intent: "newest" }),
      session("sess_old", { intent: "older" }),
    ]);

    const res = await request(app).get("/chat").query({ c: "sess_old" });

    expect(res.body.conversation_id).toBe("sess_old");
    expect(res.body.messages[0].content).toBe("older");
  });

  it("returns an empty history rather than 404 for an unknown ?c=", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([session("sess_a")]);

    const res = await request(app).get("/chat").query({ c: "sess_missing" });

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
    expect(res.body.agent).toMatchObject({ id: "agt_1" });
  });

  it("ignores a repeated ?c= that arrives as an array", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([session("sess_a", { intent: "hello" })]);

    const res = await request(app).get("/chat?c=sess_a&c=sess_b");

    // Not a string, so it falls through to "most recent chain".
    expect(res.body.conversation_id).toBe("sess_a");
  });

  it("truncates a long chain to the last 25 sessions", async () => {
    const { app, listChatForAgent } = makeApp();
    const chain = Array.from({ length: 40 }, (_, i) =>
      session(`sess_${i}`, {
        intent: `turn ${i}`,
        result_summary: `reply ${i}`,
        prior_session_id: i === 0 ? undefined : `sess_${i - 1}`,
      }),
    );
    listChatForAgent.mockResolvedValue(chain);

    const res = await request(app).get("/chat");

    expect(res.body.messages).toHaveLength(50); // 25 sessions x 2 messages
    expect(res.body.messages[0].content).toBe("turn 15");
    // prior_session_id still points at the true tail, not the window's.
    expect(res.body.prior_session_id).toBe("sess_39");
  });

  describe("in_flight_session_id", () => {
    it("is set while the tail session is still running", async () => {
      const { app, listChatForAgent } = makeApp();
      listChatForAgent.mockResolvedValue([
        session("sess_a", { status: "running", result_summary: undefined }),
      ]);

      const res = await request(app).get("/chat");
      expect(res.body.in_flight_session_id).toBe("sess_a");
    });

    it("is absent once the tail session is terminal", async () => {
      const { app, listChatForAgent } = makeApp();
      listChatForAgent.mockResolvedValue([session("sess_a", { status: "succeeded" })]);

      const res = await request(app).get("/chat");
      expect(res.body.in_flight_session_id).toBeUndefined();
    });
  });

  describe("runtime_mismatch", () => {
    it("flags a chain pinned to a different CLI than the agent now uses", async () => {
      const { app, listChatForAgent, runtimeFindById } = makeApp();
      listChatForAgent.mockResolvedValue([session("sess_a", { runtime_id: "rt_1" })]);
      runtimeFindById.mockResolvedValue({ id: "rt_1", cli: "codex" });

      const res = await request(app).get("/chat");

      expect(res.body.runtime_mismatch).toEqual({
        pinned_cli: "codex",
        current_cli: "claude_code",
      });
      expect(runtimeFindById).toHaveBeenCalledWith("rt_1");
    });

    it("is absent when the pinned CLI matches the agent's current one", async () => {
      const { app, listChatForAgent, runtimeFindById } = makeApp();
      listChatForAgent.mockResolvedValue([session("sess_a", { runtime_id: "rt_1" })]);
      runtimeFindById.mockResolvedValue({ id: "rt_1", cli: "claude_code" });

      const res = await request(app).get("/chat");
      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it("is absent when the chain is not runtime-pinned", async () => {
      const { app, listChatForAgent, runtimeFindById } = makeApp();
      listChatForAgent.mockResolvedValue([session("sess_a")]);

      const res = await request(app).get("/chat");

      expect(res.body.runtime_mismatch).toBeUndefined();
      expect(runtimeFindById).not.toHaveBeenCalled();
    });

    it("is absent when the pinned runtime row has vanished", async () => {
      const { app, listChatForAgent, runtimeFindById } = makeApp();
      listChatForAgent.mockResolvedValue([session("sess_a", { runtime_id: "rt_gone" })]);
      runtimeFindById.mockResolvedValue(undefined);

      const res = await request(app).get("/chat");
      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it("is absent when the pinned runtime reports an unrecognized CLI", async () => {
      const { app, listChatForAgent, runtimeFindById } = makeApp();
      listChatForAgent.mockResolvedValue([session("sess_a", { runtime_id: "rt_1" })]);
      runtimeFindById.mockResolvedValue({ id: "rt_1", cli: "some_future_cli" });

      const res = await request(app).get("/chat");
      expect(res.body.runtime_mismatch).toBeUndefined();
    });
  });

  it("renders a system-wake turn as a system message with the summary only", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      session("sess_a", {
        intent: "<system-wake>build finished\n\nDecide next steps.</system-wake>",
        result_summary: "Shipping it.",
      }),
    ]);

    const res = await request(app).get("/chat");

    expect(res.body.messages[0]).toEqual({
      id: "w_sess_a",
      role: "system",
      content: "build finished",
      session_id: "sess_a",
    });
  });
});

describe("POST /chat", () => {
  const send = (app: express.Express, body: unknown) =>
    request(app).post("/chat").send(body as object);

  it("rejects a non-human caller", async () => {
    const { app } = makeApp({ caller: agentCaller });
    expect((await send(app, { message: "hi" })).status).toBe(403);
  });

  it.each([
    ["a missing message", {}],
    ["an empty message", { message: "" }],
    ["a whitespace-only message", { message: "   " }],
    ["a non-string message", { message: 42 }],
  ])("400s on %s", async (_label, body) => {
    const { app, dispatchTask } = makeApp();
    const res = await send(app, body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "message_required" });
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const { app, findTopLevelForOwner, dispatchTask } = makeApp();
    findTopLevelForOwner.mockResolvedValue(null);

    const res = await send(app, { message: "hi" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "no_primary_agent" });
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("dispatches a fresh chat turn with the trimmed message", async () => {
    const { app, dispatchTask } = makeApp();
    const res = await send(app, { message: "  what is up  " });

    expect(res.status).toBe(200);
    expect(dispatchTask).toHaveBeenCalledWith({
      agentId: "agt_1",
      intent: "what is up",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
  });

  it("dispatches a continuation when prior_session_id is supplied", async () => {
    const { app, dispatchTask } = makeApp();
    await send(app, { message: "and then?", prior_session_id: "sess_prev" });

    expect(dispatchTask.mock.calls[0]?.[0]).toMatchObject({
      reason: { kind: "chat_continuation", prior_session_id: "sess_prev" },
    });
  });

  it("returns the resolved turn with the agent descriptor", async () => {
    const { app } = makeApp();
    const res = await send(app, { message: "hi" });

    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: "agt_1", name: "Scout", hierarchy: "team" },
      session_id: "sess_dispatched1",
      response: "Done.",
      status: "succeeded",
      view_refs: [],
    });
    expect(res.body.replayed).toBeUndefined();
  });

  it("renders a failed turn with the friendly failure message", async () => {
    const { app, register } = makeApp();
    register.mockResolvedValue({
      id: "sess_dispatched1",
      status: "failed",
      result_summary: null,
      error: "the runtime exploded",
    });

    const res = await send(app, { message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "failed",
      response: "the runtime exploded",
    });
  });

  describe("session_id idempotency", () => {
    const VALID = "sess_abcdef123456";

    it("only attempts a replay for a well-formed session id", async () => {
      const { app, sessionFindById, dispatchTask } = makeApp();
      await send(app, { message: "hi", session_id: "not-a-session-id" });

      expect(sessionFindById).not.toHaveBeenCalled();
      expect(dispatchTask.mock.calls[0]?.[0]).toMatchObject({
        sessionIdOverride: undefined,
      });
    });

    it("passes a well-formed session id through as the dispatch override", async () => {
      const { app, dispatchTask } = makeApp();
      await send(app, { message: "hi", session_id: VALID });

      expect(dispatchTask.mock.calls[0]?.[0]).toMatchObject({
        sessionIdOverride: VALID,
      });
    });

    it("replays a finished turn instead of spawning another", async () => {
      const { app, sessionFindById, dispatchTask } = makeApp();
      sessionFindById.mockResolvedValue({
        id: VALID,
        type: "chat",
        agent_id: "agt_1",
        status: "succeeded",
        result_summary: "cached answer",
        error: null,
      });

      const res = await send(app, { message: "hi", session_id: VALID });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        replayed: true,
        response: "cached answer",
        session_id: VALID,
      });
      expect(dispatchTask).not.toHaveBeenCalled();
    });

    it("replays a failed turn too", async () => {
      const { app, sessionFindById, dispatchTask } = makeApp();
      sessionFindById.mockResolvedValue({
        id: VALID,
        type: "chat",
        agent_id: "agt_1",
        status: "failed",
        result_summary: null,
        error: "it broke",
      });

      const res = await send(app, { message: "hi", session_id: VALID });

      expect(res.body).toMatchObject({ replayed: true, response: "it broke" });
      expect(dispatchTask).not.toHaveBeenCalled();
    });

    it("409s while the prior attempt is still running", async () => {
      const { app, sessionFindById, dispatchTask } = makeApp();
      sessionFindById.mockResolvedValue({
        id: VALID,
        type: "chat",
        agent_id: "agt_1",
        status: "running",
      });

      const res = await send(app, { message: "hi", session_id: VALID });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: "session_in_flight" });
      expect(dispatchTask).not.toHaveBeenCalled();
    });

    it("403s when the session id belongs to another caller's agent", async () => {
      const { app, sessionFindById, dispatchTask } = makeApp();
      sessionFindById.mockResolvedValue({
        id: VALID,
        type: "chat",
        agent_id: "agt_someone_else",
        status: "succeeded",
      });

      const res = await send(app, { message: "hi", session_id: VALID });

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "session_belongs_to_other_caller" });
      expect(dispatchTask).not.toHaveBeenCalled();
    });

    it("falls through to a live run when the row does not exist yet", async () => {
      const { app, sessionFindById, dispatchTask } = makeApp();
      sessionFindById.mockResolvedValue(undefined);

      const res = await send(app, { message: "hi", session_id: VALID });

      expect(res.status).toBe(200);
      expect(dispatchTask).toHaveBeenCalled();
    });

    it("falls through to a live run when the row is not a chat session", async () => {
      const { app, sessionFindById, dispatchTask } = makeApp();
      sessionFindById.mockResolvedValue({ id: VALID, type: "task", agent_id: "agt_1" });

      await send(app, { message: "hi", session_id: VALID });

      expect(dispatchTask).toHaveBeenCalled();
    });

    it("falls through to a live run for a still-pending row", async () => {
      const { app, sessionFindById, dispatchTask } = makeApp();
      sessionFindById.mockResolvedValue({
        id: VALID,
        type: "chat",
        agent_id: "agt_1",
        status: "pending",
      });

      await send(app, { message: "hi", session_id: VALID });

      expect(dispatchTask).toHaveBeenCalled();
    });
  });

  describe("rate limiting", () => {
    it("429s with turn_in_flight while a turn is already running", async () => {
      const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
      const { app } = makeApp({ rateLimiter: limiter });
      // Hold the only concurrent slot.
      limiter.acquire(PERSON);

      const res = await send(app, { message: "hi" });

      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ error: "turn_in_flight" });
      expect(res.headers["retry-after"]).toBeDefined();
      expect(typeof res.body.retry_after_ms).toBe("number");
    });

    it("429s with rate_limited once the sliding window is full", async () => {
      const limiter = new ChatRateLimiter({ maxPerWindow: 1, windowMs: 60_000 });
      const { app } = makeApp({ rateLimiter: limiter });
      limiter.acquire(PERSON).ok && limiter.acquire(PERSON);

      const res = await send(app, { message: "hi" });

      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ error: "rate_limited" });
    });

    it("releases the slot after a successful turn, so a second turn is allowed", async () => {
      const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
      const { app } = makeApp({ rateLimiter: limiter });

      expect((await send(app, { message: "one" })).status).toBe(200);
      expect((await send(app, { message: "two" })).status).toBe(200);
    });

    it("releases the slot when dispatch throws", async () => {
      const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
      const { app, dispatchTask } = makeApp({ rateLimiter: limiter });
      dispatchTask.mockRejectedValueOnce(new Error("nope"));

      expect((await send(app, { message: "one" })).status).toBe(500);
      expect((await send(app, { message: "two" })).status).toBe(200);
    });

    it("releases the slot when the agent is offline", async () => {
      const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
      const { app, dispatchTask, isOnline } = makeApp({ rateLimiter: limiter });
      dispatchTask.mockResolvedValueOnce({
        session: { id: "sess_x" },
        runtime_id: "rt_1",
      });
      isOnline.mockReturnValueOnce(false);

      expect((await send(app, { message: "one" })).status).toBe(503);
      expect((await send(app, { message: "two" })).status).toBe(200);
    });

    it("does not consume a slot on a replayed turn", async () => {
      const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
      const { app, sessionFindById } = makeApp({ rateLimiter: limiter });
      sessionFindById.mockResolvedValue({
        id: "sess_abcdef123456",
        type: "chat",
        agent_id: "agt_1",
        status: "succeeded",
        result_summary: "cached",
        error: null,
      });

      await send(app, { message: "hi", session_id: "sess_abcdef123456" });
      // The live path is still free.
      expect((await send(app, { message: "live" })).status).toBe(200);
    });
  });

  describe("daemon availability", () => {
    it("503s when the dispatched runtime is offline", async () => {
      const { app, dispatchTask, isOnline, register } = makeApp();
      dispatchTask.mockResolvedValue({
        session: { id: "sess_x" },
        runtime_id: "rt_1",
      });
      isOnline.mockReturnValue(false);

      const res = await send(app, { message: "hi" });

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: "agent_offline" });
      expect(isOnline).toHaveBeenCalledWith("rt_1");
      expect(register).not.toHaveBeenCalled();
    });

    it("proceeds when the dispatched runtime is online", async () => {
      const { app, dispatchTask, isOnline } = makeApp();
      dispatchTask.mockResolvedValue({
        session: { id: "sess_x" },
        runtime_id: "rt_1",
      });
      isOnline.mockReturnValue(true);

      expect((await send(app, { message: "hi" })).status).toBe(200);
    });

    it("proceeds without a hub check for a null-runtime agent", async () => {
      const { app, isOnline } = makeApp();
      const res = await send(app, { message: "hi" });

      expect(res.status).toBe(200);
      expect(isOnline).not.toHaveBeenCalled();
    });
  });

  describe("onboarding flag", () => {
    it("flips onboarding_completed_at on the first successful turn", async () => {
      const { app, personFindById, personUpdate } = makeApp();
      personFindById.mockResolvedValue({ id: PERSON, onboarding_completed_at: null });

      await send(app, { message: "hi" });

      expect(personUpdate).toHaveBeenCalledWith(
        PERSON,
        expect.objectContaining({ onboarding_completed_at: expect.any(Date) }),
      );
    });

    it("leaves the flag alone for an already-onboarded person", async () => {
      const { app, personUpdate } = makeApp();
      await send(app, { message: "hi" });

      expect(personUpdate).not.toHaveBeenCalled();
    });

    it("does not flip the flag when the first turn fails", async () => {
      const { app, personFindById, personUpdate, register } = makeApp();
      personFindById.mockResolvedValue({ id: PERSON, onboarding_completed_at: null });
      register.mockResolvedValue({
        id: "sess_x",
        status: "failed",
        result_summary: null,
        error: "boom",
      });

      await send(app, { message: "hi" });

      expect(personUpdate).not.toHaveBeenCalled();
    });

    it("still answers the turn when the flag write rejects", async () => {
      const { app, personFindById, personUpdate } = makeApp();
      personFindById.mockResolvedValue({ id: PERSON, onboarding_completed_at: null });
      personUpdate.mockRejectedValue(new Error("write failed"));

      const res = await send(app, { message: "hi" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("treats a missing person row as still onboarding", async () => {
      const { app, personFindById, personUpdate } = makeApp();
      personFindById.mockResolvedValue(undefined);

      await send(app, { message: "hi" });

      expect(personUpdate).toHaveBeenCalled();
    });
  });

  describe("failures", () => {
    it("500s when dispatch throws", async () => {
      const { app, dispatchTask } = makeApp();
      dispatchTask.mockRejectedValue(new Error("no capacity"));

      const res = await send(app, { message: "hi" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("internal_error");
      expect(res.body.request_id).toMatch(/^req_/);
      expect(JSON.stringify(res.body)).not.toContain("no capacity");
    });

    it("504s when the resolver times out", async () => {
      const { app, register } = makeApp();
      register.mockRejectedValue(new Error("chat resolver timeout after 90000ms"));

      const res = await send(app, { message: "hi" });

      expect(res.status).toBe(504);
      expect(res.body).toMatchObject({
        error: "chat_turn_timeout",
        timeout_ms: 90_000,
      });
    });

    it("500s on any other resolver failure", async () => {
      const { app, register } = makeApp();
      register.mockRejectedValue(new Error("resolver exploded"));

      const res = await send(app, { message: "hi" });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe("internal_error");
    });
  });
});
