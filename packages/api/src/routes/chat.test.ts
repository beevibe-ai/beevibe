/**
 * The /chat router — the human chat surface.
 *
 * `chat-internals.test.ts` covers the exported pure helpers
 * (`groupIntoConversations`, `chainToMessages`, `failureMessageFor`).
 * This file covers the HTTP layer around them: the auth gate, the
 * idempotent-replay ladder on POST, the rate-limit and daemon-offline
 * refusals, the resolver timeout, the onboarding flip, and what GET
 * puts on the wire.
 *
 * Every collaborator is injected, so the router mounts on a bare
 * Express app with stub repos — no database, no daemon, no CLI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { json, type RequestHandler } from "express";
import request from "supertest";
import type {
  AgentRepository,
  PersonRepository,
  RuntimeRepository,
  Session,
  SessionRepository,
  SessionStatus,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { createChatRouter } from "./chat.js";

const PERSON = "per_alice";
const AGENT = {
  id: "agt_team",
  name: "Team Lead",
  hierarchy_level: "team",
  runtime_config: { type: "claude" },
};

const humanCaller = { source: "human", personId: PERSON };
const agentCaller = { source: "agent", personId: PERSON, agentId: "agt_1" };

function callerAs(caller: unknown): RequestHandler {
  return (req, _res, next) => {
    if (caller !== null) (req as { caller?: unknown }).caller = caller;
    next();
  };
}

/** A chat session row as `listChatForAgent` would hand it back. */
function chatSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_aaaaaaaaaaaa",
    type: "chat",
    status: "succeeded",
    agent_id: AGENT.id,
    intent: "hello",
    result_summary: "hi there",
    created_at: new Date("2026-05-01T10:00:00Z"),
    ...overrides,
  } as Session;
}

interface Stubs {
  findTopLevelForOwner: ReturnType<typeof vi.fn>;
  personFindById: ReturnType<typeof vi.fn>;
  personUpdate: ReturnType<typeof vi.fn>;
  runtimeFindById: ReturnType<typeof vi.fn>;
  listChatForAgent: ReturnType<typeof vi.fn>;
  sessionFindById: ReturnType<typeof vi.fn>;
  softDeleteChatChain: ReturnType<typeof vi.fn>;
  dispatchTask: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  isOnline: ReturnType<typeof vi.fn>;
}

function makeApp(
  opts: {
    caller?: unknown;
    agent?: unknown;
    rateLimiter?: ChatRateLimiter;
  } = {},
): { app: express.Express } & Stubs {
  const agent = "agent" in opts ? opts.agent : AGENT;

  const stubs: Stubs = {
    findTopLevelForOwner: vi.fn(async () => agent),
    personFindById: vi.fn(async () => ({
      id: PERSON,
      onboarding_completed_at: new Date("2026-01-01"),
    })),
    personUpdate: vi.fn(async () => undefined),
    runtimeFindById: vi.fn(async () => undefined),
    listChatForAgent: vi.fn(async () => [] as Session[]),
    sessionFindById: vi.fn(async () => undefined),
    softDeleteChatChain: vi.fn(async () => 0),
    dispatchTask: vi.fn(async () => ({
      session: chatSession({ id: "sess_bbbbbbbbbbbb", status: "pending" }),
      runtime_id: null,
    })),
    register: vi.fn(async () =>
      chatSession({ id: "sess_bbbbbbbbbbbb", result_summary: "done" }),
    ),
    isOnline: vi.fn(() => true),
  };

  const router = createChatRouter({
    authMiddleware: callerAs("caller" in opts ? opts.caller : humanCaller),
    agentRepo: {
      findTopLevelForOwner: stubs.findTopLevelForOwner,
    } as unknown as AgentRepository,
    personRepo: {
      findById: stubs.personFindById,
      update: stubs.personUpdate,
    } as unknown as PersonRepository,
    runtimeRepo: {
      findById: stubs.runtimeFindById,
    } as unknown as RuntimeRepository,
    sessionRepo: {
      listChatForAgent: stubs.listChatForAgent,
      findById: stubs.sessionFindById,
      softDeleteChatChain: stubs.softDeleteChatChain,
    } as unknown as SessionRepository,
    dispatchService: {
      dispatchTask: stubs.dispatchTask,
    } as unknown as DispatchService,
    chatResolver: { register: stubs.register } as unknown as ChatResolver,
    hub: { isOnline: stubs.isOnline } as unknown as DaemonHub,
    rateLimiter: opts.rateLimiter,
  });

  const app = express();
  app.use(json());
  app.use("/chat", router);
  return { app, ...stubs };
}

/** First argument of a mock's first call, as a readable bag of fields. */
function firstArgOf(mock: {
  mock: { calls: unknown[][] };
}): Record<string, unknown> {
  return mock.mock.calls[0]![0] as Record<string, unknown>;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  vi.useRealTimers();
});

describe("chat routes — auth", () => {
  it.each([
    ["GET /chat", "get", "/chat"],
    ["GET /chat/conversations", "get", "/chat/conversations"],
    ["DELETE /chat/conversations/:headId", "delete", "/chat/conversations/sess_1"],
    ["POST /chat", "post", "/chat"],
  ])("%s refuses an agent caller", async (_label, method, path) => {
    const { app, findTopLevelForOwner } = makeApp({ caller: agentCaller });
    const send = (request(app) as unknown as Record<string, (p: string) => Promise<request.Response>>)[
      method
    ]!;
    const res = await send(path);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
    expect(findTopLevelForOwner).not.toHaveBeenCalled();
  });
});

describe("GET /chat/conversations", () => {
  it("returns an empty list when the caller has no primary agent", async () => {
    const { app, listChatForAgent } = makeApp({ agent: undefined });
    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain with a title, turn count and preview", async () => {
    const head = chatSession({
      id: "sess_head0000",
      intent: "plan the migration",
      result_summary: "sure",
      created_at: new Date("2026-05-01T10:00:00Z"),
    });
    const tail = chatSession({
      id: "sess_tail0000",
      prior_session_id: head.id,
      intent: "and then?",
      result_summary: "then   we\nship it",
      created_at: new Date("2026-05-01T11:00:00Z"),
    });
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([head, tail]);

    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: head.id,
        // Title comes from the head turn; the preview from the tail.
        title: "plan the migration",
        turn_count: 2,
        last_at: tail.created_at.toISOString(),
        last_preview: "then we ship it",
      },
    ]);
  });

  it("truncates a long conversation title to 80 chars", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatSession({ intent: "z".repeat(200) }),
    ]);
    const res = await request(app).get("/chat/conversations");
    const title = res.body.conversations[0].title as string;
    expect(title).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("previews the error when a failed turn has no summary", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatSession({
        status: "failed",
        result_summary: undefined,
        error: "spawn ENOENT",
      }),
    ]);
    const res = await request(app).get("/chat/conversations");
    expect(res.body.conversations[0].last_preview).toBe("spawn ENOENT");
  });

  it("clips a long preview to 140 chars", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatSession({ result_summary: "y".repeat(500) }),
    ]);
    const preview = (await request(app).get("/chat/conversations")).body
      .conversations[0].last_preview as string;
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("DELETE /chat/conversations/:headId", () => {
  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const { app, softDeleteChatChain } = makeApp();
    softDeleteChatChain.mockResolvedValue(3);
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(softDeleteChatChain).toHaveBeenCalledWith("sess_head", AGENT.id);
  });

  it("is idempotent — a chain already gone deletes zero rows", async () => {
    const { app, softDeleteChatChain } = makeApp();
    softDeleteChatChain.mockResolvedValue(0);
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("404s when the caller has no primary agent", async () => {
    const { app, softDeleteChatChain } = makeApp({ agent: undefined });
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
    expect(softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("500s with a request id when the delete throws", async () => {
    const { app, softDeleteChatChain } = makeApp();
    softDeleteChatChain.mockRejectedValue(new Error("deadlock detected"));
    const res = await request(app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // The detail stays in the logs, not on the wire.
    expect(JSON.stringify(res.body)).not.toContain("deadlock");
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("GET /chat", () => {
  it("returns a null agent when none is provisioned", async () => {
    const { app } = makeApp({ agent: undefined });
    const res = await request(app).get("/chat");
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns an empty conversation when the agent has no chats", async () => {
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

  it("rehydrates the most recent chain by default", async () => {
    const { app, listChatForAgent } = makeApp();
    const older = chatSession({
      id: "sess_old000000",
      intent: "old topic",
      created_at: new Date("2026-05-01T09:00:00Z"),
    });
    const newer = chatSession({
      id: "sess_new000000",
      intent: "new topic",
      created_at: new Date("2026-05-02T09:00:00Z"),
    });
    listChatForAgent.mockResolvedValue([older, newer]);

    const res = await request(app).get("/chat");
    expect(res.body.conversation_id).toBe(newer.id);
    expect(res.body.prior_session_id).toBe(newer.id);
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "new topic",
      "hi there",
    ]);
  });

  it("renders a failed turn in history as an agent bubble", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([
      chatSession({
        status: "failed",
        intent: "deploy it",
        result_summary: undefined,
        error: "beevibe runtime 'codex' not found on this daemon",
      }),
    ]);
    const res = await request(app).get("/chat");
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[1]).toMatchObject({
      role: "agent",
      session_id: "sess_aaaaaaaaaaaa",
    });
    expect(res.body.messages[1].content).toContain("codex");
  });

  it("honors ?c= to select an older conversation", async () => {
    const { app, listChatForAgent } = makeApp();
    const older = chatSession({
      id: "sess_old000000",
      intent: "old topic",
      created_at: new Date("2026-05-01T09:00:00Z"),
    });
    const newer = chatSession({
      id: "sess_new000000",
      intent: "new topic",
      created_at: new Date("2026-05-02T09:00:00Z"),
    });
    listChatForAgent.mockResolvedValue([older, newer]);

    const res = await request(app).get("/chat").query({ c: older.id });
    expect(res.body.conversation_id).toBe(older.id);
  });

  it("renders the empty state rather than 404 for an unknown ?c=", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([chatSession()]);
    const res = await request(app).get("/chat").query({ c: "sess_nope" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("caps the rehydrated window at 25 sessions", async () => {
    const { app, listChatForAgent } = makeApp();
    // One long chain of 30 turns; HISTORY_LIMIT/2 = 25 survive.
    const chain = Array.from({ length: 30 }, (_, i) =>
      chatSession({
        id: `sess_${String(i).padStart(12, "0")}`,
        prior_session_id: i === 0 ? undefined : `sess_${String(i - 1).padStart(12, "0")}`,
        intent: `turn ${i}`,
        created_at: new Date(Date.UTC(2026, 4, 1, i)),
      }),
    );
    listChatForAgent.mockResolvedValue(chain);

    const res = await request(app).get("/chat");
    // 25 sessions × (user + agent) messages.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].content).toBe("turn 5");
    expect(res.body.conversation_id).toBe(chain[0]!.id);
  });

  it.each([["pending"], ["running"]] as Array<[SessionStatus]>)(
    "flags a %s tail session so the UI can resume its indicator",
    async (status) => {
      const { app, listChatForAgent } = makeApp();
      listChatForAgent.mockResolvedValue([
        chatSession({ status, result_summary: undefined }),
      ]);
      const res = await request(app).get("/chat");
      expect(res.body.in_flight_session_id).toBe("sess_aaaaaaaaaaaa");
    },
  );

  it("omits in_flight_session_id once the tail is terminal", async () => {
    const { app, listChatForAgent } = makeApp();
    listChatForAgent.mockResolvedValue([chatSession({ status: "succeeded" })]);
    const res = await request(app).get("/chat");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("reports a runtime mismatch when the chain is pinned to another CLI", async () => {
    const { app, listChatForAgent, runtimeFindById } = makeApp();
    listChatForAgent.mockResolvedValue([chatSession({ runtime_id: "rt_1" })]);
    runtimeFindById.mockResolvedValue({ id: "rt_1", cli: "codex" });

    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toEqual({
      pinned_cli: "codex",
      current_cli: "claude",
    });
  });

  it.each([
    ["the chain has no runtime_id", undefined, undefined],
    ["the runtime row is gone", "rt_1", undefined],
    ["the pinned cli is unknown", "rt_1", { id: "rt_1", cli: "wat" }],
    ["the pinned cli matches", "rt_1", { id: "rt_1", cli: "claude" }],
  ])("omits runtime_mismatch when %s", async (_label, runtimeId, runtime) => {
    const { app, listChatForAgent, runtimeFindById } = makeApp();
    listChatForAgent.mockResolvedValue([chatSession({ runtime_id: runtimeId })]);
    runtimeFindById.mockResolvedValue(runtime);

    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });
});

describe("POST /chat — validation", () => {
  it.each([
    ["omitted", {}],
    ["empty", { message: "" }],
    ["whitespace only", { message: "   " }],
    ["not a string", { message: 42 }],
  ])("400s when message is %s", async (_label, body) => {
    const { app, dispatchTask } = makeApp();
    const res = await request(app).post("/chat").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const { app, dispatchTask } = makeApp({ agent: undefined });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("trims the message before dispatching it", async () => {
    const { app, dispatchTask } = makeApp();
    await request(app).post("/chat").send({ message: "  hi there  " });
    expect(firstArgOf(dispatchTask).intent).toBe("hi there");
  });
});

describe("POST /chat — dispatch", () => {
  it("dispatches a fresh chat turn", async () => {
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

  it("sends a chat_continuation reason when prior_session_id is given", async () => {
    const { app, dispatchTask } = makeApp();
    await request(app)
      .post("/chat")
      .send({ message: "and then?", prior_session_id: "sess_prior" });
    expect(firstArgOf(dispatchTask).reason).toEqual({
      kind: "chat_continuation",
      prior_session_id: "sess_prior",
    });
  });

  it("passes a well-formed client session id through as the override", async () => {
    const { app, dispatchTask } = makeApp();
    await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abcdefghijkl" });
    expect(firstArgOf(dispatchTask).sessionIdOverride).toBe(
      "sess_abcdefghijkl",
    );
  });

  it.each([
    ["the wrong prefix", "chat_abcdefghijkl"],
    ["the wrong length", "sess_abc"],
    ["illegal characters", "sess_abcdefghij-l"],
  ])("ignores a session_id with %s", async (_label, sessionId) => {
    const { app, dispatchTask, sessionFindById } = makeApp();
    await request(app).post("/chat").send({ message: "hi", session_id: sessionId });
    expect(sessionFindById).not.toHaveBeenCalled();
    expect(firstArgOf(dispatchTask).sessionIdOverride).toBeUndefined();
  });

  it("returns the resolved turn with the agent and parsed response", async () => {
    const { app } = makeApp();
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT.id, name: AGENT.name, hierarchy: "team" },
      session_id: "sess_bbbbbbbbbbbb",
      response: "done",
      status: "succeeded",
      view_refs: [],
    });
    expect(res.body.replayed).toBeUndefined();
  });

  it("maps a failed turn to the friendly failure message", async () => {
    const { app, register } = makeApp();
    register.mockResolvedValue(
      chatSession({
        id: "sess_bbbbbbbbbbbb",
        status: "failed",
        result_summary: undefined,
        error: "npm ERR! missing script",
      }),
    );
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.response).toBe("npm ERR! missing script");
  });

  it("500s when dispatch throws, and frees the rate-limit slot", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const { app, dispatchTask } = makeApp({ rateLimiter });
    dispatchTask.mockRejectedValue(new Error("pool exhausted"));

    const first = await request(app).post("/chat").send({ message: "hi" });
    expect(first.status).toBe(500);
    expect(first.body.error).toBe("internal_error");

    // Slot released — a second attempt gets past the concurrency gate
    // and fails on dispatch again rather than 429-ing.
    const second = await request(app).post("/chat").send({ message: "hi" });
    expect(second.status).toBe(500);
  });
});

describe("POST /chat — daemon availability", () => {
  it("503s when the pinned runtime's daemon is offline", async () => {
    const { app, dispatchTask, isOnline, register } = makeApp();
    dispatchTask.mockResolvedValue({
      session: chatSession({ id: "sess_bbbbbbbbbbbb", status: "pending" }),
      runtime_id: "rt_1",
    });
    isOnline.mockReturnValue(false);

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(isOnline).toHaveBeenCalledWith("rt_1");
    expect(register).not.toHaveBeenCalled();
  });

  it("proceeds for a null runtime_id — the in-process executor claims it", async () => {
    const { app, isOnline, register } = makeApp();
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(isOnline).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalled();
  });
});

describe("POST /chat — idempotent replay", () => {
  const sessionId = "sess_abcdefghijkl";

  it("replays a finished turn instead of spawning another", async () => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue(
      chatSession({ id: sessionId, status: "succeeded", result_summary: "cached" }),
    );

    const res = await request(app).post("/chat").send({ message: "hi", session_id: sessionId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      replayed: true,
      session_id: sessionId,
      response: "cached",
      status: "succeeded",
    });
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed turn with its failure message", async () => {
    const { app, sessionFindById } = makeApp();
    sessionFindById.mockResolvedValue(
      chatSession({
        id: sessionId,
        status: "failed",
        result_summary: undefined,
        error: "boom",
      }),
    );
    const res = await request(app).post("/chat").send({ message: "hi", session_id: sessionId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replayed: true, response: "boom" });
  });

  it("409s while the same session is still running", async () => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue(
      chatSession({ id: sessionId, status: "running" }),
    );
    const res = await request(app).post("/chat").send({ message: "hi", session_id: sessionId });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the session id belongs to another caller's agent", async () => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue(
      chatSession({ id: sessionId, agent_id: "agt_someone_else" }),
    );
    const res = await request(app).post("/chat").send({ message: "hi", session_id: sessionId });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
    expect(dispatchTask).not.toHaveBeenCalled();
  });

  it.each([
    ["the row does not exist", undefined],
    ["the row is not a chat session", { ...chatSession(), type: "task" }],
  ])("falls through to dispatch when %s", async (_label, existing) => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue(existing);
    const res = await request(app).post("/chat").send({ message: "hi", session_id: sessionId });
    expect(res.status).toBe(200);
    expect(dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("falls through to dispatch for a pending row (never claimed)", async () => {
    const { app, sessionFindById, dispatchTask } = makeApp();
    sessionFindById.mockResolvedValue(
      chatSession({ id: sessionId, status: "pending" }),
    );
    const res = await request(app).post("/chat").send({ message: "hi", session_id: sessionId });
    expect(res.status).toBe(200);
    expect(dispatchTask).toHaveBeenCalledTimes(1);
  });
});

describe("POST /chat — rate limiting", () => {
  it("429s with turn_in_flight when a turn is already running", async () => {
    let now = 0;
    const rateLimiter = new ChatRateLimiter({
      maxConcurrent: 1,
      now: () => now,
    });
    // Occupy the only slot and never release it.
    const held = rateLimiter.acquire(PERSON);
    expect(held.ok).toBe(true);

    const { app, dispatchTask } = makeApp({ rateLimiter });
    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("turn_in_flight");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(dispatchTask).not.toHaveBeenCalled();
    now += 1;
  });

  it("429s with rate_limited once the sliding window fills", async () => {
    const rateLimiter = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 2,
      windowMs: 60_000,
      now: () => 1_000,
    });
    const { app } = makeApp({ rateLimiter });

    await request(app).post("/chat").send({ message: "one" });
    await request(app).post("/chat").send({ message: "two" });
    const third = await request(app).post("/chat").send({ message: "three" });

    expect(third.status).toBe(429);
    expect(third.body.error).toBe("rate_limited");
    expect(third.body.retry_after_ms).toBe(60_000);
    expect(third.headers["retry-after"]).toBe("60");
  });

  it("checks replay before the rate limiter, so a retry is never throttled", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
    rateLimiter.acquire(PERSON); // slot held by the in-flight original
    const { app, sessionFindById } = makeApp({ rateLimiter });
    sessionFindById.mockResolvedValue(
      chatSession({ id: "sess_abcdefghijkl", result_summary: "cached" }),
    );

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abcdefghijkl" });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
  });
});

describe("POST /chat — turn timeout", () => {
  it("504s when the resolver times out", async () => {
    const { app, register } = makeApp();
    register.mockRejectedValue(
      new Error("chat resolver timeout (90000ms) for sess_b"),
    );
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      error: "chat_turn_timeout",
      timeout_ms: 90_000,
    });
    expect(res.body.message).toContain("90s");
  });

  it("500s on any other resolver failure", async () => {
    const { app, register } = makeApp();
    register.mockRejectedValue(new Error("resolver double-registered"));
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });

  it("releases the rate-limit slot after a timeout", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const { app, register } = makeApp({ rateLimiter });
    register.mockRejectedValueOnce(new Error("chat resolver timeout (90000ms)"));

    expect((await request(app).post("/chat").send({ message: "hi" })).status).toBe(
      504,
    );
    expect((await request(app).post("/chat").send({ message: "hi" })).status).toBe(
      200,
    );
  });
});

describe("POST /chat — onboarding flip", () => {
  it("stamps onboarding_completed_at on the first successful turn", async () => {
    const { app, personFindById, personUpdate } = makeApp();
    personFindById.mockResolvedValue({ id: PERSON, onboarding_completed_at: null });

    await request(app).post("/chat").send({ message: "hi" });
    expect(personUpdate).toHaveBeenCalledWith(PERSON, {
      onboarding_completed_at: expect.any(Date),
    });
  });

  it("leaves an already-onboarded person alone", async () => {
    const { app, personUpdate } = makeApp();
    await request(app).post("/chat").send({ message: "hi" });
    expect(personUpdate).not.toHaveBeenCalled();
  });

  it("does not flip the flag on a failed first turn", async () => {
    const { app, personFindById, personUpdate, register } = makeApp();
    personFindById.mockResolvedValue({ id: PERSON, onboarding_completed_at: null });
    register.mockResolvedValue(
      chatSession({ id: "sess_bbbbbbbbbbbb", status: "failed", error: "nope" }),
    );

    await request(app).post("/chat").send({ message: "hi" });
    expect(personUpdate).not.toHaveBeenCalled();
  });

  it("still answers the turn when the flag write fails", async () => {
    const { app, personFindById, personUpdate } = makeApp();
    personFindById.mockResolvedValue({ id: PERSON, onboarding_completed_at: null });
    personUpdate.mockRejectedValue(new Error("write conflict"));

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
