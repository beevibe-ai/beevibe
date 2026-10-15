/**
 * Chat HTTP surface — router-level tests with vitest fakes (no DB).
 *
 * `chat-internals.test.ts` already covers the three exported pure
 * helpers (`groupIntoConversations`, `failureMessageFor`,
 * `chainToMessages`). What's left — and what this file covers — is the
 * route behaviour those helpers feed into, plus the module-private
 * logic reachable only through a request: the idempotent-replay
 * decision tree, the rate-limit envelope, the offline-daemon 503, the
 * resolver timeout 504, the runtime-mismatch probe, and the
 * conversation list/delete handlers.
 */
import express, { json, type NextFunction, type Request, type Response } from "express";
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
const AGENT = "agent_team";

/**
 * The fakes stand in for DB rows, where the optional columns come back
 * as `null` rather than absent. The domain types declare them
 * `?: T`, so widen the override bag to accept the shape the route
 * actually sees at runtime.
 */
type RowOverrides<T> = { [K in keyof T]?: T[K] | null };

function fakeAgent(overrides: RowOverrides<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Hermes",
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    ...overrides,
  } as unknown as Agent;
}

function fakePerson(overrides: RowOverrides<Person> = {}): Person {
  return {
    id: PERSON,
    name: "Ada",
    email: "ada@example.com",
    onboarding_completed_at: new Date("2026-01-01"),
    ...overrides,
  } as unknown as Person;
}

function chatSession(overrides: RowOverrides<Session> = {}): Session {
  return {
    id: "sess_aaaaaaaaaaaa",
    type: "chat",
    agent_id: AGENT,
    intent: "hello",
    status: "succeeded",
    result_summary: "hi there",
    error: null,
    created_at: new Date("2026-05-01T10:00:00Z"),
    ...overrides,
  } as unknown as Session;
}

function stubAuth(source: "human" | "agent" | "none") {
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
  source?: "human" | "agent" | "none";
  agent?: Agent | undefined;
  person?: Person | undefined;
  chats?: Session[];
  /** Row returned by sessionRepo.findById — drives the replay branch. */
  existing?: Session | undefined;
  runtime?: Runtime | undefined;
  /** dispatchService.dispatchTask outcome. */
  dispatch?: { session: { id: string }; runtime_id: string | null } | Error;
  /** chatResolver.register outcome. */
  resolved?: Session | Error;
  online?: boolean;
  softDeleted?: number | Error;
  rateLimiter?: ChatRateLimiter;
}

function makeApp(opts: AppOpts = {}) {
  const agentRepo = {
    findTopLevelForOwner: vi.fn(async () =>
      "agent" in opts ? opts.agent : fakeAgent(),
    ),
  } as unknown as AgentRepository;

  const personRepo = {
    findById: vi.fn(async () => ("person" in opts ? opts.person : fakePerson())),
    update: vi.fn(async () => fakePerson()),
  } as unknown as PersonRepository;

  const sessionRepo = {
    listChatForAgent: vi.fn(async () => opts.chats ?? []),
    findById: vi.fn(async () => opts.existing),
    softDeleteChatChain: vi.fn(async () => {
      if (opts.softDeleted instanceof Error) throw opts.softDeleted;
      return opts.softDeleted ?? 0;
    }),
  } as unknown as SessionRepository;

  const runtimeRepo = {
    findById: vi.fn(async () => opts.runtime),
  } as unknown as RuntimeRepository;

  const dispatchService = {
    dispatchTask: vi.fn(async () => {
      if (opts.dispatch instanceof Error) throw opts.dispatch;
      return (
        opts.dispatch ?? {
          session: { id: "sess_dispatched1" },
          runtime_id: null,
        }
      );
    }),
  } as unknown as DispatchService;

  const chatResolver = {
    register: vi.fn(async () => {
      if (opts.resolved instanceof Error) throw opts.resolved;
      return opts.resolved ?? chatSession({ id: "sess_dispatched1" });
    }),
  } as unknown as ChatResolver;

  const hub = {
    isOnline: vi.fn(() => opts.online ?? true),
  } as unknown as DaemonHub;

  const deps: ChatRoutesDeps = {
    authMiddleware: stubAuth(opts.source ?? "human"),
    agentRepo,
    personRepo,
    runtimeRepo,
    sessionRepo,
    dispatchService,
    chatResolver,
    hub,
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
  };

  const app = express();
  app.use(json());
  app.use("/chat", createChatRouter(deps));

  return { app, agentRepo, personRepo, sessionRepo, runtimeRepo, dispatchService, chatResolver, hub };
}

describe("auth gate", () => {
  it.each([
    ["GET /chat", (app: express.Express) => request(app).get("/chat")],
    ["GET /chat/conversations", (app: express.Express) => request(app).get("/chat/conversations")],
    [
      "DELETE /chat/conversations/:headId",
      (app: express.Express) => request(app).delete("/chat/conversations/sess_h"),
    ],
    [
      "POST /chat",
      (app: express.Express) => request(app).post("/chat").send({ message: "hi" }),
    ],
  ])("403s an agent caller on %s", async (_label, call) => {
    const { app } = makeApp({ source: "agent" });
    const res = await call(app);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "human_required" });
  });

  it("403s an unauthenticated caller", async () => {
    const { app } = makeApp({ source: "none" });

    expect((await request(app).get("/chat")).status).toBe(403);
  });
});

describe("GET /chat/conversations", () => {
  it("returns an empty list when the caller has no primary agent", async () => {
    const { app, sessionRepo } = makeApp({ agent: undefined });
    const res = await request(app).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain with its title, turn count and tail preview", async () => {
    const head = chatSession({
      id: "sess_head00000001",
      intent: "Refactor the auth module",
      created_at: new Date("2026-05-01T10:00:00Z"),
    });
    const tail = chatSession({
      id: "sess_tail00000001",
      prior_session_id: head.id,
      intent: "and add tests",
      result_summary: "Added 12 tests.",
      created_at: new Date("2026-05-01T10:05:00Z"),
    });
    const { app } = makeApp({ chats: [head, tail] });
    const res = await request(app).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head00000001",
        title: "Refactor the auth module",
        turn_count: 2,
        last_at: "2026-05-01T10:05:00.000Z",
        last_preview: "Added 12 tests.",
      },
    ]);
  });

  it("falls back to the error, then the intent, for a chain with no summary", async () => {
    const failed = chatSession({
      id: "sess_f00000000001",
      intent: "deploy it",
      result_summary: null,
      status: "failed",
      error: "daemon exploded",
    });
    const bare = chatSession({
      id: "sess_b00000000001",
      intent: "   still   thinking\nabout it ",
      result_summary: null,
      error: null,
      status: "running",
    });
    const { app } = makeApp({ chats: [failed, bare] });
    const res = await request(app).get("/chat/conversations");

    const previews = Object.fromEntries(
      (res.body.conversations as Array<{ head_id: string; last_preview: string }>).map(
        (c) => [c.head_id, c.last_preview],
      ),
    );
    expect(previews["sess_f00000000001"]).toBe("daemon exploded");
    expect(previews["sess_b00000000001"]).toBe("still thinking about it");
  });

  it("clips a long preview to 140 chars with an ellipsis", async () => {
    const long = "z".repeat(300);
    const { app } = makeApp({
      chats: [chatSession({ id: "sess_long00000001", result_summary: long })],
    });
    const res = await request(app).get("/chat/conversations");

    expect(res.body.conversations[0].last_preview).toBe("z".repeat(139) + "…");
  });

  it("caps the list at 50 conversations", async () => {
    const chats = Array.from({ length: 60 }, (_, i) =>
      chatSession({
        id: `sess_c${String(i).padStart(11, "0")}`,
        created_at: new Date(Date.UTC(2026, 4, 1, 0, i)),
      }),
    );
    const { app } = makeApp({ chats });
    const res = await request(app).get("/chat/conversations");

    expect(res.body.conversations).toHaveLength(50);
  });
});

describe("DELETE /chat/conversations/:headId", () => {
  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const { app, sessionRepo } = makeApp({ softDeleted: 3 });
    const res = await request(app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(sessionRepo.softDeleteChatChain).toHaveBeenCalledWith(
      "sess_head00000001",
      AGENT,
    );
  });

  it("is idempotent — a chain already deleted reports zero rows, not an error", async () => {
    const { app } = makeApp({ softDeleted: 0 });
    const res = await request(app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("404s when the caller has no primary agent", async () => {
    const { app, sessionRepo } = makeApp({ agent: undefined });
    const res = await request(app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "agent_not_found" });
    expect(sessionRepo.softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("500s with a request id, not the internal detail, when the repo throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({ softDeleted: new Error("connection terminated") });
    const res = await request(app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    expect(JSON.stringify(res.body)).not.toContain("connection terminated");
    err.mockRestore();
  });
});

describe("GET /chat", () => {
  it("returns a null agent and no messages when none is provisioned", async () => {
    const { app } = makeApp({ agent: undefined });
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

  it("returns the agent with an empty chain when there are no chats yet", async () => {
    const { app } = makeApp({ chats: [] });
    const res = await request(app).get("/chat");

    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Hermes", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("rehydrates the most recent conversation by default", async () => {
    const older = chatSession({
      id: "sess_old000000001",
      intent: "old topic",
      created_at: new Date("2026-05-01T09:00:00Z"),
    });
    const newer = chatSession({
      id: "sess_new000000001",
      intent: "new topic",
      result_summary: "done",
      created_at: new Date("2026-05-01T11:00:00Z"),
    });
    const { app } = makeApp({ chats: [older, newer] });
    const res = await request(app).get("/chat");

    expect(res.body.conversation_id).toBe("sess_new000000001");
    expect(res.body.prior_session_id).toBe("sess_new000000001");
    expect(res.body.messages).toEqual([
      { id: "u_sess_new000000001", role: "user", content: "new topic" },
      {
        id: "a_sess_new000000001",
        role: "agent",
        content: "done",
        session_id: "sess_new000000001",
      },
    ]);
  });

  it("honours the ?c= conversation selector", async () => {
    const a = chatSession({
      id: "sess_a00000000001",
      intent: "topic a",
      created_at: new Date("2026-05-01T09:00:00Z"),
    });
    const b = chatSession({
      id: "sess_b00000000001",
      intent: "topic b",
      created_at: new Date("2026-05-01T11:00:00Z"),
    });
    const { app } = makeApp({ chats: [a, b] });
    const res = await request(app).get("/chat?c=sess_a00000000001");

    expect(res.body.conversation_id).toBe("sess_a00000000001");
  });

  it("renders the empty state, not a 404, for an unknown ?c=", async () => {
    const { app } = makeApp({ chats: [chatSession({ id: "sess_a00000000001" })] });
    const res = await request(app).get("/chat?c=sess_missing0001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Hermes", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("truncates a long chain to the newest 25 turns", async () => {
    const chats: Session[] = [];
    for (let i = 0; i < 40; i++) {
      chats.push(
        chatSession({
          id: `sess_t${String(i).padStart(11, "0")}`,
          prior_session_id: i === 0 ? undefined : `sess_t${String(i - 1).padStart(11, "0")}`,
          intent: `turn ${i}`,
          result_summary: `reply ${i}`,
          created_at: new Date(Date.UTC(2026, 4, 1, 0, i)),
        }),
      );
    }
    const { app } = makeApp({ chats });
    const res = await request(app).get("/chat");

    // 25 sessions × (user + agent) messages.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0]).toMatchObject({ content: "turn 15" });
  });

  it("hydrates display directives on a rehydrated agent turn", async () => {
    const summary = [
      '<open_view path="/tasks/task_abcdefghijkl" label="Open the task" />',
      '<suggest_action label="Ship it" prompt="deploy to prod" />',
      '<repo_card repo_url="https://github.com/acme/tool" stars="120" language="Python" />',
      "Done — tracked as task_abcdefghijkl.",
    ].join("\n");
    const { app } = makeApp({
      chats: [chatSession({ id: "sess_dir000000001", result_summary: summary })],
    });
    const res = await request(app).get("/chat");

    const agentMsg = res.body.messages[1];
    expect(agentMsg.content).toBe("Done — tracked as task_abcdefghijkl.");
    expect(agentMsg.view_refs).toEqual(["task_abcdefghijkl"]);
    expect(agentMsg.open_view).toMatchObject({ path: "/tasks/task_abcdefghijkl" });
    expect(agentMsg.suggested_actions).toEqual([
      { label: "Ship it", prompt: "deploy to prod" },
    ]);
    expect(agentMsg.repo_cards).toMatchObject([
      { repo_url: "https://github.com/acme/tool", stars: 120, language: "Python" },
    ]);
  });

  it("rehydrates a failed turn as an agent message carrying the failure", async () => {
    const { app } = makeApp({
      chats: [
        chatSession({
          id: "sess_fail00000001",
          intent: "deploy it",
          status: "failed",
          result_summary: null,
          error: "the daemon could not reach the registry",
        }),
      ],
    });
    const res = await request(app).get("/chat");

    expect(res.body.messages).toEqual([
      { id: "u_sess_fail00000001", role: "user", content: "deploy it" },
      {
        id: "a_sess_fail00000001",
        role: "agent",
        content: "the daemon could not reach the registry",
        session_id: "sess_fail00000001",
      },
    ]);
  });

  it("omits the directive keys when the turn carried none", async () => {
    const { app } = makeApp({
      chats: [chatSession({ id: "sess_pla000000001", result_summary: "just prose" })],
    });
    const res = await request(app).get("/chat");

    const agentMsg = res.body.messages[1];
    expect(agentMsg).toEqual({
      id: "a_sess_pla000000001",
      role: "agent",
      content: "just prose",
      session_id: "sess_pla000000001",
    });
  });

  it("surfaces the tail session id as in-flight while it is still running", async () => {
    const { app } = makeApp({
      chats: [
        chatSession({
          id: "sess_run000000001",
          status: "running",
          result_summary: null,
        }),
      ],
    });
    const res = await request(app).get("/chat");

    expect(res.body.in_flight_session_id).toBe("sess_run000000001");
  });

  it("omits in_flight_session_id for a settled tail", async () => {
    const { app } = makeApp({ chats: [chatSession({ status: "succeeded" })] });
    const res = await request(app).get("/chat");

    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  describe("runtime mismatch probe", () => {
    it("reports the pinned CLI when it differs from the agent's current one", async () => {
      const { app, runtimeRepo } = makeApp({
        chats: [chatSession({ runtime_id: "rt_1" })],
        runtime: { id: "rt_1", cli: "codex" } as unknown as Runtime,
      });
      const res = await request(app).get("/chat");

      expect(runtimeRepo.findById).toHaveBeenCalledWith("rt_1");
      expect(res.body.runtime_mismatch).toEqual({
        pinned_cli: "codex",
        current_cli: "claude",
      });
    });

    it("stays silent when the pinned CLI matches", async () => {
      const { app } = makeApp({
        chats: [chatSession({ runtime_id: "rt_1" })],
        runtime: { id: "rt_1", cli: "claude" } as unknown as Runtime,
      });
      const res = await request(app).get("/chat");

      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it.each([
      ["the tail has no runtime_id", { chats: [chatSession({ runtime_id: undefined })] }],
      [
        "the runtime row is gone",
        { chats: [chatSession({ runtime_id: "rt_gone" })], runtime: undefined },
      ],
      [
        "the runtime's cli is not a known CLI",
        {
          chats: [chatSession({ runtime_id: "rt_1" })],
          runtime: { id: "rt_1", cli: "zshbot" } as unknown as Runtime,
        },
      ],
    ])("skips the probe when %s", async (_label, extra) => {
      const { app } = makeApp(extra as AppOpts);
      const res = await request(app).get("/chat");

      expect(res.body.runtime_mismatch).toBeUndefined();
    });
  });
});

describe("POST /chat validation", () => {
  it.each([
    ["an absent message", {}],
    ["a blank message", { message: "   " }],
    ["a non-string message", { message: 42 }],
  ])("400s %s before resolving the agent", async (_label, body) => {
    const { app, agentRepo } = makeApp();
    const res = await request(app).post("/chat").send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "message_required" });
    expect(agentRepo.findTopLevelForOwner).not.toHaveBeenCalled();
  });

  it("404s when no primary agent is provisioned", async () => {
    const { app, dispatchService } = makeApp({ agent: undefined });
    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "no_primary_agent" });
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });
});

describe("POST /chat dispatch", () => {
  it("dispatches a fresh chat turn and returns the resolved reply", async () => {
    const { app, dispatchService } = makeApp({
      resolved: chatSession({ id: "sess_dispatched1", result_summary: "all done" }),
    });
    const res = await request(app).post("/chat").send({ message: "  hi there  " });

    expect(res.status).toBe(200);
    expect(dispatchService.dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      intent: "hi there",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Hermes", hierarchy: "team" },
      session_id: "sess_dispatched1",
      response: "all done",
      status: "succeeded",
    });
    expect(res.body.replayed).toBeUndefined();
  });

  it("passes prior_session_id through as a chat_continuation resume reason", async () => {
    const { app, dispatchService } = makeApp();
    await request(app)
      .post("/chat")
      .send({ message: "and now?", prior_session_id: "sess_prior000001" });

    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_prior000001" },
      }),
    );
  });

  it("forwards a well-formed client session_id as the override", async () => {
    const { app, dispatchService } = makeApp({ existing: undefined });
    await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abcdefghijkl" });

    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: "sess_abcdefghijkl" }),
    );
  });

  it.each([
    ["too short", "sess_abc"],
    ["wrong prefix", "chat_abcdefghijkl"],
    ["illegal characters", "sess_abcdef-hijkl"],
    ["not a string", 7],
  ])("ignores a client session_id that is %s", async (_label, sessionId) => {
    const { app, dispatchService, sessionRepo } = makeApp();
    await request(app).post("/chat").send({ message: "hi", session_id: sessionId });

    expect(sessionRepo.findById).not.toHaveBeenCalled();
    expect(dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: undefined }),
    );
  });

  it("503s when the dispatched session is daemon-bound but the daemon is offline", async () => {
    const { app, chatResolver, hub } = makeApp({
      dispatch: { session: { id: "sess_dispatched1" }, runtime_id: "rt_1" },
      online: false,
    });
    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "agent_offline" });
    expect(hub.isOnline).toHaveBeenCalledWith("rt_1");
    expect(chatResolver.register).not.toHaveBeenCalled();
  });

  it("does not consult the hub for a null-runtime session (executor fallback)", async () => {
    const { app, hub, chatResolver } = makeApp({
      dispatch: { session: { id: "sess_dispatched1" }, runtime_id: null },
      online: false,
    });
    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(hub.isOnline).not.toHaveBeenCalled();
    expect(chatResolver.register).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("500s when dispatch itself throws", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({ dispatch: new Error("no runtime bound") });
    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(JSON.stringify(res.body)).not.toContain("no runtime bound");
    err.mockRestore();
  });

  it("504s when the resolver times out waiting for the turn", async () => {
    const { app } = makeApp({
      resolved: new Error("chat turn timeout after 90000ms"),
    });
    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      error: "chat_turn_timeout",
      timeout_ms: 90_000,
    });
  });

  it("500s on a non-timeout resolver failure", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({ resolved: new Error("resolver bug") });
    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    err.mockRestore();
  });

  it("renders a failed turn with the friendlier failure message", async () => {
    const { app } = makeApp({
      resolved: chatSession({
        id: "sess_dispatched1",
        status: "failed",
        result_summary: null,
        error: "pip install blew up",
      }),
    });
    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "failed", response: "pip install blew up" });
  });
});

describe("POST /chat onboarding flip", () => {
  it("stamps onboarding_completed_at on the first successful turn", async () => {
    const { app, personRepo } = makeApp({
      person: fakePerson({ onboarding_completed_at: null }),
    });
    await request(app).post("/chat").send({ message: "hi" });

    expect(personRepo.update).toHaveBeenCalledWith(
      PERSON,
      expect.objectContaining({ onboarding_completed_at: expect.any(Date) }),
    );
  });

  it("leaves an already-onboarded person alone", async () => {
    const { app, personRepo } = makeApp();
    await request(app).post("/chat").send({ message: "hi" });

    expect(personRepo.update).not.toHaveBeenCalled();
  });

  it("does not flip the flag when the first turn failed", async () => {
    const { app, personRepo } = makeApp({
      person: fakePerson({ onboarding_completed_at: null }),
      resolved: chatSession({ status: "failed", error: "boom" }),
    });
    await request(app).post("/chat").send({ message: "hi" });

    expect(personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers the turn when the flag write rejects", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, personRepo } = makeApp({
      person: fakePerson({ onboarding_completed_at: null }),
    });
    (personRepo.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("write failed"),
    );
    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    err.mockRestore();
  });
});

describe("POST /chat idempotent replay", () => {
  const CALLER_SID = "sess_abcdefghijkl";

  it("replays a succeeded turn instead of spawning another subprocess", async () => {
    const { app, dispatchService } = makeApp({
      existing: chatSession({
        id: CALLER_SID,
        status: "succeeded",
        result_summary: "cached reply",
      }),
    });
    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      session_id: CALLER_SID,
      response: "cached reply",
      status: "succeeded",
      replayed: true,
    });
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed turn with its failure message", async () => {
    const { app } = makeApp({
      existing: chatSession({
        id: CALLER_SID,
        status: "failed",
        result_summary: null,
        error: "the CLI could not start",
      }),
    });
    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SID });

    expect(res.body).toMatchObject({
      status: "failed",
      response: "the CLI could not start",
      replayed: true,
    });
  });

  it("409s a retry against a turn that is still running", async () => {
    const { app, dispatchService } = makeApp({
      existing: chatSession({ id: CALLER_SID, status: "running" }),
    });
    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SID });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "session_in_flight" });
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the session id collides with another caller's row", async () => {
    const { app, dispatchService } = makeApp({
      existing: chatSession({ id: CALLER_SID, agent_id: "agent_someone_else" }),
    });
    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SID });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "session_belongs_to_other_caller" });
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("falls through to dispatch when the row is pending (claimed but unfinished)", async () => {
    const { app, dispatchService } = makeApp({
      existing: chatSession({ id: CALLER_SID, status: "pending" }),
    });
    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SID });

    expect(res.status).toBe(200);
    expect(dispatchService.dispatchTask).toHaveBeenCalled();
  });

  it.each([
    ["no row exists", undefined],
    ["the row is not a chat session", chatSession({ id: CALLER_SID, type: "task" })],
  ])("falls through to dispatch when %s", async (_label, existing) => {
    const { app, dispatchService } = makeApp({ existing: existing as Session | undefined });
    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SID });

    expect(res.status).toBe(200);
    expect(dispatchService.dispatchTask).toHaveBeenCalled();
  });
});

describe("POST /chat rate limiting", () => {
  it("429s with turn_in_flight and a Retry-After when a turn is already running", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    rateLimiter.acquire(PERSON); // occupy the only slot
    const { app, dispatchService } = makeApp({ rateLimiter });
    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "turn_in_flight" });
    expect(res.headers["retry-after"]).toBeDefined();
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("429s with rate_limited once the sliding window is full", async () => {
    const rateLimiter = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 1,
      windowMs: 60_000,
      now: () => 1_000,
    });
    rateLimiter.acquire(PERSON); // spend the window's single slot
    const { app } = makeApp({ rateLimiter });
    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: "rate_limited" });
    expect(res.body.retry_after_ms).toBeGreaterThan(0);
  });

  it("releases the slot after a successful turn so the next one gets through", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const { app } = makeApp({ rateLimiter });

    expect((await request(app).post("/chat").send({ message: "one" })).status).toBe(200);
    expect((await request(app).post("/chat").send({ message: "two" })).status).toBe(200);
  });

  it.each([
    ["dispatch throws", { dispatch: new Error("boom") } as AppOpts],
    ["the daemon is offline", {
      dispatch: { session: { id: "sess_dispatched1" }, runtime_id: "rt_1" },
      online: false,
    } as AppOpts],
    ["the resolver times out", { resolved: new Error("timeout") } as AppOpts],
  ])("releases the slot when %s", async (_label, extra) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const { app } = makeApp({ ...extra, rateLimiter });

    await request(app).post("/chat").send({ message: "one" });
    // The slot must be free again — otherwise the retry would 429.
    const retry = await request(app).post("/chat").send({ message: "two" });

    expect(retry.status).not.toBe(429);
    err.mockRestore();
  });
});
