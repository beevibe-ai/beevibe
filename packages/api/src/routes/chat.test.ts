/**
 * The human chat router — unit tests with vitest fakes (no DB).
 *
 * `chat-internals.test.ts` already pins the pure helpers
 * (groupIntoConversations, chainToMessages, failureMessageFor). This
 * suite covers the router that wraps them: the human gate on all four
 * routes, the primary-agent resolution, and — on `POST /` — the chain
 * of guards that decide whether a turn costs money. That POST path is
 * the expensive one: every fall-through spawns a CLI subprocess, so
 * the replay/rate-limit/offline branches that stop it short are worth
 * pinning precisely, as are the 503/504 shapes the chat UI branches on.
 *
 * Ports are fakes; `chatResolver.register` is a promise the test
 * resolves by hand, which is what lets the async POST path be driven
 * deterministically without a daemon.
 */
import express, { json } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  Person,
  PersonRepository,
  RuntimeRepository,
  Session,
  SessionRepository,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { createChatRouter, type ChatRoutesDeps, type ChatSession } from "./chat.js";

const PERSON = "person_alice";
const AGENT = "agent_alicesteam";
const SESSION_ID = "sess_abc123abc123"; // matches the /^sess_[A-Za-z0-9]{12}$/ gate

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Alice's Team",
    owner_id: PERSON,
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
  } as unknown as Agent;
}

function chatSession(overrides: Partial<ChatSession> & Pick<ChatSession, "id">): ChatSession {
  return {
    intent: "hello",
    status: "succeeded",
    result_summary: "hi there",
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    type: "chat",
    agent_id: AGENT,
    status: "succeeded",
    intent: "hello",
    result_summary: "hi there",
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as unknown as Session;
}

type Ports = Omit<ChatRoutesDeps, "authMiddleware">;

function makePorts(overrides: Partial<Ports> = {}): Ports {
  return {
    agentRepo: {
      findTopLevelForOwner: vi.fn(async () => fakeAgent()),
    } as unknown as AgentRepository,
    personRepo: {
      findById: vi.fn(async () => ({
        id: PERSON,
        onboarding_completed_at: new Date("2026-01-01T00:00:00Z"),
      }) as unknown as Person),
      update: vi.fn(async () => ({}) as unknown as Person),
    } as unknown as PersonRepository,
    runtimeRepo: {
      findById: vi.fn(async () => ({ id: "rt_1", cli: "claude" })),
    } as unknown as RuntimeRepository,
    sessionRepo: {
      listChatForAgent: vi.fn(async () => [] as ChatSession[]),
      findById: vi.fn(async () => null),
      softDeleteChatChain: vi.fn(async () => 3),
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

function stubAuth(source: "human" | "agent" | "none") {
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

function makeApp(ports: Ports = makePorts(), source: "human" | "agent" | "none" = "human") {
  const app = express();
  app.use(json());
  app.use("/", createChatRouter({ authMiddleware: stubAuth(source), ...ports }));
  return app;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

// ── The human gate ───────────────────────────────────────────────────────

describe("human gate", () => {
  const ROUTES: ReadonlyArray<[method: "get" | "post" | "delete", path: string]> = [
    ["get", "/"],
    ["get", "/conversations"],
    ["delete", "/conversations/sess_head000000"],
    ["post", "/"],
  ];

  for (const [method, path] of ROUTES) {
    it(`403s ${method.toUpperCase()} ${path} for an agent token`, async () => {
      const res = await request(makeApp(makePorts(), "agent"))[method](path);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("human_required");
    });

    it(`403s ${method.toUpperCase()} ${path} for an unauthenticated caller`, async () => {
      const res = await request(makeApp(makePorts(), "none"))[method](path);
      expect(res.status).toBe(403);
    });
  }
});

// ── GET /conversations ───────────────────────────────────────────────────

describe("GET /conversations", () => {
  it("returns an empty list when the caller has no primary agent", async () => {
    const ports = makePorts({
      agentRepo: {
        findTopLevelForOwner: vi.fn(async () => null),
      } as unknown as AgentRepository,
    });
    const res = await request(makeApp(ports)).get("/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(ports.sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain by head, turn count, last activity and preview", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          chatSession({
            id: "sess_head000000",
            intent: "how do I deploy",
            created_at: new Date("2026-02-01T00:00:00Z"),
          }),
          chatSession({
            id: "sess_turn200000",
            prior_session_id: "sess_head000000",
            intent: "and the rollback",
            result_summary: "Run `vercel rollback`.",
            created_at: new Date("2026-02-01T00:05:00Z"),
          }),
        ]),
      } as unknown as SessionRepository,
    });

    const res = await request(makeApp(ports)).get("/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head000000",
        title: "how do I deploy",
        turn_count: 2,
        last_at: "2026-02-01T00:05:00.000Z",
        last_preview: "Run `vercel rollback`.",
      },
    ]);
  });

  it("truncates a long title to the shared thread-title ceiling", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          chatSession({ id: "sess_head000000", intent: "y".repeat(200) }),
        ]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/conversations");
    expect((res.body.conversations[0].title as string).length).toBeLessThanOrEqual(80);
  });

  it("falls back to the error, then the intent, when there's no summary", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          chatSession({
            id: "sess_erro00000",
            intent: "deploy it",
            result_summary: undefined,
            error: "CLI blew up",
            created_at: new Date("2026-02-02T00:00:00Z"),
          }),
          chatSession({
            id: "sess_bare00000",
            intent: "still thinking",
            result_summary: undefined,
            error: undefined,
            status: "running",
            created_at: new Date("2026-02-01T00:00:00Z"),
          }),
        ]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/conversations");
    const previews = Object.fromEntries(
      (res.body.conversations as Array<Record<string, string>>).map((c) => [
        c.head_id,
        c.last_preview,
      ]),
    );
    expect(previews.sess_erro00000).toBe("CLI blew up");
    expect(previews.sess_bare00000).toBe("still thinking");
  });

  it("collapses whitespace and ellipsizes an over-long preview", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          chatSession({
            id: "sess_long00000",
            result_summary: "a\n\nb" + "c".repeat(300),
          }),
        ]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/conversations");
    const preview = res.body.conversations[0].last_preview as string;
    expect(preview).toHaveLength(140);
    expect(preview.startsWith("a b")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("caps the list at 50 conversations even when more chains exist", async () => {
    const sessions = Array.from({ length: 60 }, (_, i) =>
      chatSession({
        id: `sess_c${String(i).padStart(9, "0")}`,
        created_at: new Date(2026, 0, 1, 0, i),
      }),
    );
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => sessions),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/conversations");
    expect(res.body.conversations).toHaveLength(50);
    // Newest chain first.
    expect(res.body.conversations[0].head_id).toBe("sess_c000000059");
  });
});

// ── DELETE /conversations/:headId ────────────────────────────────────────

describe("DELETE /conversations/:headId", () => {
  it("soft-deletes the chain scoped to the caller's own agent", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports)).delete("/conversations/sess_head000000");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(ports.sessionRepo.softDeleteChatChain).toHaveBeenCalledWith(
      "sess_head000000",
      AGENT,
    );
  });

  it("is idempotent — re-deleting an already-deleted chain still returns ok", async () => {
    const ports = makePorts({
      sessionRepo: {
        softDeleteChatChain: vi.fn(async () => 0),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).delete("/conversations/sess_head000000");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("404s when the caller has no primary agent", async () => {
    const ports = makePorts({
      agentRepo: {
        findTopLevelForOwner: vi.fn(async () => null),
      } as unknown as AgentRepository,
    });
    const res = await request(makeApp(ports)).delete("/conversations/sess_head000000");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
    expect(ports.sessionRepo.softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("500s with a request_id — and no internal detail — when the repo throws", async () => {
    const ports = makePorts({
      sessionRepo: {
        softDeleteChatChain: vi.fn(async () => {
          throw new Error("deadlock detected on session_pkey");
        }),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).delete("/conversations/sess_head000000");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    expect(JSON.stringify(res.body)).not.toContain("deadlock");
  });
});

// ── GET / ────────────────────────────────────────────────────────────────

describe("GET /", () => {
  it("returns a null agent and empty history when none is provisioned", async () => {
    const ports = makePorts({
      agentRepo: {
        findTopLevelForOwner: vi.fn(async () => null),
      } as unknown as AgentRepository,
    });
    const res = await request(makeApp(ports)).get("/");
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
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          chatSession({ id: "sess_old000000", created_at: new Date("2026-01-01T00:00:00Z") }),
          chatSession({ id: "sess_new000000", created_at: new Date("2026-03-01T00:00:00Z") }),
        ]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/");
    expect(res.body.conversation_id).toBe("sess_new000000");
    expect(res.body.prior_session_id).toBe("sess_new000000");
    expect(res.body.agent).toEqual({ id: AGENT, name: "Alice's Team", hierarchy: "team" });
  });

  it("selects the chain named by ?c=", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          chatSession({ id: "sess_old000000", created_at: new Date("2026-01-01T00:00:00Z") }),
          chatSession({ id: "sess_new000000", created_at: new Date("2026-03-01T00:00:00Z") }),
        ]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/?c=sess_old000000");
    expect(res.body.conversation_id).toBe("sess_old000000");
  });

  it("renders the empty state — not a 404 — for an unknown ?c=", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [chatSession({ id: "sess_new000000" })]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/?c=sess_nope000000");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
    expect(res.body.agent).not.toBeNull();
  });

  it("reconstructs the chain as user/assistant messages", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          chatSession({
            id: "sess_head000000",
            intent: "how do I deploy",
            result_summary: "Run `vercel --prod`.",
          }),
        ]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/");
    // The user turn carries no session_id — the client keys the reply
    // slot off the agent message, which does.
    expect(res.body.messages).toEqual([
      { id: "u_sess_head000000", role: "user", content: "how do I deploy" },
      {
        id: "a_sess_head000000",
        role: "agent",
        content: "Run `vercel --prod`.",
        session_id: "sess_head000000",
      },
    ]);
  });

  it("renders a failed turn in history with the friendlier failure message", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          chatSession({
            id: "sess_fail00000",
            intent: "deploy it",
            status: "failed",
            result_summary: undefined,
            error: "npm ERR! ENOSPC",
          }),
        ]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/");
    expect(res.body.messages).toEqual([
      { id: "u_sess_fail00000", role: "user", content: "deploy it" },
      {
        id: "a_sess_fail00000",
        role: "agent",
        content: "npm ERR! ENOSPC",
        session_id: "sess_fail00000",
      },
    ]);
  });

  it("points a failed turn with no useful detail at the daemon log", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          chatSession({
            id: "sess_bare00000",
            status: "failed",
            result_summary: undefined,
            error: undefined,
          }),
        ]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/");
    expect(res.body.messages[1].content).toContain("beevibe-daemon start");
  });

  it("truncates history to the last 25 sessions of a long chain", async () => {
    const sessions = Array.from({ length: 40 }, (_, i) =>
      chatSession({
        id: `sess_t${String(i).padStart(9, "0")}`,
        prior_session_id: i === 0 ? undefined : `sess_t${String(i - 1).padStart(9, "0")}`,
        created_at: new Date(2026, 0, 1, 0, i),
      }),
    );
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => sessions),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/");
    // 25 sessions × (user + agent). The window keeps the *tail*, but
    // conversation_id still names the chain's real head, so the client
    // can page back into the older turns.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.conversation_id).toBe("sess_t000000000");
    expect(res.body.messages[0].id).toBe("u_sess_t000000015");
    expect(res.body.prior_session_id).toBe("sess_t000000039");
  });

  it.each(["pending", "running"])(
    "surfaces in_flight_session_id when the tail is %s",
    async (status) => {
      const ports = makePorts({
        sessionRepo: {
          listChatForAgent: vi.fn(async () => [
            chatSession({ id: "sess_live00000", status, result_summary: undefined }),
          ]),
        } as unknown as SessionRepository,
      });
      const res = await request(makeApp(ports)).get("/");
      expect(res.body.in_flight_session_id).toBe("sess_live00000");
    },
  );

  it("omits in_flight_session_id once the tail has settled", async () => {
    const res = await request(
      makeApp(
        makePorts({
          sessionRepo: {
            listChatForAgent: vi.fn(async () => [chatSession({ id: "sess_done00000" })]),
          } as unknown as SessionRepository,
        }),
      ),
    ).get("/");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  describe("runtime pinning", () => {
    function portsPinnedTo(cli: string | undefined, agentCli = "claude") {
      return makePorts({
        agentRepo: {
          findTopLevelForOwner: vi.fn(
            async () =>
              ({ ...fakeAgent(), runtime_config: { type: agentCli } }) as unknown as Agent,
          ),
        } as unknown as AgentRepository,
        sessionRepo: {
          listChatForAgent: vi.fn(async () => [
            chatSession({ id: "sess_head000000", runtime_id: "rt_1" }),
          ]),
        } as unknown as SessionRepository,
        runtimeRepo: {
          findById: vi.fn(async () => (cli ? { id: "rt_1", cli } : null)),
        } as unknown as RuntimeRepository,
      });
    }

    it("flags a chain pinned to a different CLI than the agent now uses", async () => {
      const res = await request(makeApp(portsPinnedTo("codex", "claude"))).get("/");
      expect(res.body.runtime_mismatch).toEqual({
        pinned_cli: "codex",
        current_cli: "claude",
      });
    });

    it("stays silent when the pinned CLI matches", async () => {
      const res = await request(makeApp(portsPinnedTo("claude", "claude"))).get("/");
      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it("stays silent when the runtime row is gone or its cli is unknown", async () => {
      for (const cli of [undefined, "some-fork"]) {
        const res = await request(makeApp(portsPinnedTo(cli, "claude"))).get("/");
        expect(res.body.runtime_mismatch).toBeUndefined();
      }
    });

    it("skips the runtime lookup entirely for an unpinned chain", async () => {
      const ports = makePorts({
        sessionRepo: {
          listChatForAgent: vi.fn(async () => [chatSession({ id: "sess_head000000" })]),
        } as unknown as SessionRepository,
      });
      const res = await request(makeApp(ports)).get("/");
      expect(res.body.runtime_mismatch).toBeUndefined();
      expect(ports.runtimeRepo.findById).not.toHaveBeenCalled();
    });
  });
});

// ── POST / ───────────────────────────────────────────────────────────────

describe("POST / validation", () => {
  it("400s on a missing, blank or non-string message", async () => {
    const ports = makePorts();
    for (const message of [undefined, "", "   ", 42, null]) {
      const res = await request(makeApp(ports)).post("/").send({ message });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("message_required");
    }
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const ports = makePorts({
      agentRepo: {
        findTopLevelForOwner: vi.fn(async () => null),
      } as unknown as AgentRepository,
    });
    const res = await request(makeApp(ports)).post("/").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
  });

  it("trims the message before dispatching it", async () => {
    const ports = makePorts();
    await request(makeApp(ports)).post("/").send({ message: "  hi there  " });
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "hi there", type: "chat", agentId: AGENT }),
    );
  });

  it("dispatches a continuation when prior_session_id is present, else fresh", async () => {
    const ports = makePorts();
    const app = makeApp(ports);

    await request(app).post("/").send({ message: "hi" });
    expect(ports.dispatchService.dispatchTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: { kind: "fresh" } }),
    );

    await request(app).post("/").send({ message: "hi", prior_session_id: "sess_prior00000" });
    expect(ports.dispatchService.dispatchTask).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_prior00000" },
      }),
    );
  });

  it("only honors a client session_id that matches the sess_ id format", async () => {
    const ports = makePorts();
    const app = makeApp(ports);

    await request(app).post("/").send({ message: "hi", session_id: SESSION_ID });
    expect(ports.dispatchService.dispatchTask).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionIdOverride: SESSION_ID }),
    );

    for (const session_id of ["nope", "sess_short", "sess_way_too_long_here", 7]) {
      await request(app).post("/").send({ message: "hi", session_id });
      expect(ports.dispatchService.dispatchTask).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionIdOverride: undefined }),
      );
    }
  });
});

/**
 * Idempotent retry. Every fall-through here is a fresh CLI subprocess,
 * so a double-submit that reaches dispatch is a real double charge.
 */
describe("POST / replay", () => {
  function portsWithExisting(existing: Session | null) {
    return makePorts({
      sessionRepo: {
        findById: vi.fn(async () => existing),
      } as unknown as SessionRepository,
    });
  }

  it("replays a settled turn's persisted result instead of spawning again", async () => {
    const ports = portsWithExisting(
      fakeSession({ status: "succeeded", result_summary: "the earlier answer" }),
    );
    const res = await request(makeApp(ports))
      .post("/")
      .send({ message: "hi", session_id: SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      replayed: true,
      session_id: SESSION_ID,
      response: "the earlier answer",
      status: "succeeded",
    });
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed turn with the friendlier failure message", async () => {
    const ports = portsWithExisting(
      fakeSession({ status: "failed", result_summary: undefined, error: "disk full" }),
    );
    const res = await request(makeApp(ports))
      .post("/")
      .send({ message: "hi", session_id: SESSION_ID });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replayed: true, status: "failed", response: "disk full" });
  });

  it("409s while the same session is still running", async () => {
    const ports = portsWithExisting(fakeSession({ status: "running" }));
    const res = await request(makeApp(ports))
      .post("/")
      .send({ message: "hi", session_id: SESSION_ID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the session id collides with another person's session", async () => {
    const ports = portsWithExisting(fakeSession({ agent_id: "agent_someone_else" }));
    const res = await request(makeApp(ports))
      .post("/")
      .send({ message: "hi", session_id: SESSION_ID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("falls through to a live turn when the row is absent, non-chat, or still pending", async () => {
    for (const existing of [
      null,
      fakeSession({ type: "task" }),
      fakeSession({ status: "pending" }),
    ]) {
      const ports = portsWithExisting(existing);
      const res = await request(makeApp(ports))
        .post("/")
        .send({ message: "hi", session_id: SESSION_ID });
      expect(res.status).toBe(200);
      expect(res.body.replayed).toBeUndefined();
      expect(ports.dispatchService.dispatchTask).toHaveBeenCalledTimes(1);
    }
  });

  it("skips the lookup entirely when the client sent no session_id", async () => {
    const ports = portsWithExisting(fakeSession());
    await request(makeApp(ports)).post("/").send({ message: "hi" });
    expect(ports.sessionRepo.findById).not.toHaveBeenCalled();
  });
});

describe("POST / rate limiting", () => {
  it("429s with turn_in_flight and Retry-After once the concurrent slot is taken", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const first = limiter.acquire(PERSON); // occupy the only slot
    expect(first.ok).toBe(true);

    const ports = makePorts();
    const app = express();
    app.use(json());
    app.use(
      "/",
      createChatRouter({ authMiddleware: stubAuth("human"), ...ports, rateLimiter: limiter }),
    );

    const res = await request(app).post("/").send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("turn_in_flight");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("429s with rate_limited once the sliding window is full", async () => {
    const limiter = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 2,
      windowMs: 60_000,
      now: () => 1_000,
    });
    limiter.acquire(PERSON).ok && limiter.acquire(PERSON);

    const ports = makePorts();
    const app = express();
    app.use(json());
    app.use(
      "/",
      createChatRouter({ authMiddleware: stubAuth("human"), ...ports, rateLimiter: limiter }),
    );

    const res = await request(app).post("/").send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.body.retry_after_ms).toBeGreaterThan(0);
  });

  it("releases the slot after a completed turn so the next one goes through", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const ports = makePorts();
    const app = express();
    app.use(json());
    app.use(
      "/",
      createChatRouter({ authMiddleware: stubAuth("human"), ...ports, rateLimiter: limiter }),
    );

    expect((await request(app).post("/").send({ message: "one" })).status).toBe(200);
    expect((await request(app).post("/").send({ message: "two" })).status).toBe(200);
  });

  it("releases the slot when dispatch throws, rather than wedging the person", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const ports = makePorts({
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw new Error("agent not found");
        }),
      } as unknown as DispatchService,
    });
    const app = express();
    app.use(json());
    app.use(
      "/",
      createChatRouter({ authMiddleware: stubAuth("human"), ...ports, rateLimiter: limiter }),
    );

    const failed = await request(app).post("/").send({ message: "hi" });
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe("internal_error");
    // The slot is free again — a second attempt gets past the limiter
    // (and fails on dispatch again, not with a 429).
    const second = await request(app).post("/").send({ message: "hi" });
    expect(second.status).toBe(500);
  });
});

describe("POST / dispatch outcomes", () => {
  it("503s when the chat is daemon-bound but that daemon is offline", async () => {
    const ports = makePorts({
      dispatchService: {
        dispatchTask: vi.fn(async () => ({
          session: fakeSession({ status: "pending" }),
          runtime_id: "rt_1",
        })),
      } as unknown as DispatchService,
      hub: { isOnline: vi.fn(() => false) } as unknown as DaemonHub,
    });
    const res = await request(makeApp(ports)).post("/").send({ message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(ports.chatResolver.register).not.toHaveBeenCalled();
  });

  it("proceeds for a null-runtime agent — the in-process executor claims it", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports)).post("/").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(ports.hub.isOnline).not.toHaveBeenCalled();
  });

  it("returns the resolved turn once the daemon reports done", async () => {
    const ports = makePorts({
      chatResolver: {
        register: vi.fn(async () =>
          fakeSession({ id: "sess_done00000", result_summary: "all set" }),
        ),
      } as unknown as ChatResolver,
    });
    const res = await request(makeApp(ports)).post("/").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      session_id: "sess_done00000",
      response: "all set",
      status: "succeeded",
      agent: { id: AGENT, name: "Alice's Team", hierarchy: "team" },
    });
    expect(res.body.replayed).toBeUndefined();
  });

  it("registers the resolver against the dispatched session with the 90s cap", async () => {
    const ports = makePorts();
    await request(makeApp(ports)).post("/").send({ message: "hi" });
    expect(ports.chatResolver.register).toHaveBeenCalledWith(SESSION_ID, 90_000);
  });

  it("504s when the resolver times out waiting on the daemon", async () => {
    const ports = makePorts({
      chatResolver: {
        register: vi.fn(async () => {
          throw new Error("chat resolver timeout (90000ms) for sess_x");
        }),
      } as unknown as ChatResolver,
    });
    const res = await request(makeApp(ports)).post("/").send({ message: "hi" });
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ error: "chat_turn_timeout", timeout_ms: 90_000 });
  });

  it("500s on any other resolver failure", async () => {
    const ports = makePorts({
      chatResolver: {
        register: vi.fn(async () => {
          throw new Error("resolver already registered");
        }),
      } as unknown as ChatResolver,
    });
    const res = await request(makeApp(ports)).post("/").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });

  it("renders a failed turn with the friendlier failure message", async () => {
    const ports = makePorts({
      chatResolver: {
        register: vi.fn(async () =>
          fakeSession({ status: "failed", result_summary: undefined, error: "out of memory" }),
        ),
      } as unknown as ChatResolver,
    });
    const res = await request(makeApp(ports)).post("/").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "failed", response: "out of memory" });
  });
});

/**
 * The welcome wizard exits on the first *successful* chat turn. The
 * flip is fire-and-forget, so a failed write must not fail the turn.
 */
describe("POST / onboarding flip", () => {
  const onboarding = () =>
    ({
      findById: vi.fn(async () => ({ id: PERSON, onboarding_completed_at: null })),
      update: vi.fn(async () => ({})),
    }) as unknown as PersonRepository;

  it("stamps onboarding_completed_at after the first successful turn", async () => {
    const personRepo = onboarding();
    await request(makeApp(makePorts({ personRepo }))).post("/").send({ message: "hi" });
    expect(personRepo.update).toHaveBeenCalledWith(
      PERSON,
      expect.objectContaining({ onboarding_completed_at: expect.any(Date) }),
    );
  });

  it("leaves the wizard open when the first turn fails", async () => {
    const personRepo = onboarding();
    const ports = makePorts({
      personRepo,
      chatResolver: {
        register: vi.fn(async () => fakeSession({ status: "failed" })),
      } as unknown as ChatResolver,
    });
    await request(makeApp(ports)).post("/").send({ message: "hi" });
    expect(personRepo.update).not.toHaveBeenCalled();
  });

  it("doesn't re-stamp a person who already finished onboarding", async () => {
    const ports = makePorts();
    await request(makeApp(ports)).post("/").send({ message: "hi" });
    expect(ports.personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers the turn when the flip write fails", async () => {
    const personRepo = {
      findById: vi.fn(async () => ({ id: PERSON, onboarding_completed_at: null })),
      update: vi.fn(async () => {
        throw new Error("write conflict");
      }),
    } as unknown as PersonRepository;

    const res = await request(makeApp(makePorts({ personRepo })))
      .post("/")
      .send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("treats a missing person row as still onboarding", async () => {
    const personRepo = {
      findById: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    } as unknown as PersonRepository;
    await request(makeApp(makePorts({ personRepo }))).post("/").send({ message: "hi" });
    expect(personRepo.update).toHaveBeenCalled();
  });
});
