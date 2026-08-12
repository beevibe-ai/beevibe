/**
 * `createChatRouter` — the human chat surface — unit tests with vitest
 * fakes (no DB, no CLI).
 *
 * `chat-internals.test.ts` already pins the pure helpers
 * (`groupIntoConversations`, `chainToMessages`, `failureMessageFor`).
 * This suite covers the other half of the file: the four handlers and
 * the branches only reachable through them — the human gate, the
 * conversation list + soft delete, history rehydration (chain
 * selection, in-flight tail, runtime-mismatch flag) and the whole POST
 * ladder (validation → idempotent replay → rate limit → dispatch →
 * daemon-offline → resolver → onboarding flip → timeout).
 *
 * Every port is a `vi.fn()` stub. `ChatRateLimiter` is the real class
 * with an injected clock, since the 429 bodies it drives are part of
 * the wire contract these tests pin. `processResponse` also runs for
 * real — the directive stripping it does is visible in every response
 * body below.
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
import { createChatRouter, type ChatRoutesDeps, type ChatSession } from "./chat.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const PERSON = "person_alice";
const AGENT = "agent_alicesteam";
// The route only accepts a caller-supplied session id matching
// /^sess_[A-Za-z0-9]{12}$/ — anything else falls through to a fresh
// dispatch, which is its own test below.
const VALID_CALLER_SESSION = "sess_abc123def456";

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

function fakeChat(overrides: Partial<ChatSession> & Pick<ChatSession, "id">): ChatSession {
  return {
    intent: "hello",
    status: "succeeded",
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_dispatched01",
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-01-02T00:00:00Z"),
    updated_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  } as Session;
}

// ── Fake ports ───────────────────────────────────────────────────────────

interface Ports {
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  runtimeRepo: RuntimeRepository;
  sessionRepo: SessionRepository;
  dispatchService: DispatchService;
  chatResolver: ChatResolver;
  hub: DaemonHub;
  rateLimiter?: ChatRateLimiter;
}

function makePorts(overrides: Partial<Ports> = {}): Ports {
  return {
    agentRepo: {
      findTopLevelForOwner: vi.fn(async () => fakeAgent()),
    } as unknown as AgentRepository,
    personRepo: {
      findById: vi.fn(
        async (id: string) =>
          ({ id, name: "Alice", onboarding_completed_at: new Date() }) as Person,
      ),
      update: vi.fn(async () => undefined),
    } as unknown as PersonRepository,
    runtimeRepo: {
      findById: vi.fn(async () => undefined),
    } as unknown as RuntimeRepository,
    sessionRepo: {
      listChatForAgent: vi.fn(async () => [] as ChatSession[]),
      softDeleteChatChain: vi.fn(async () => 0),
      findById: vi.fn(async () => undefined),
    } as unknown as SessionRepository,
    dispatchService: {
      dispatchTask: vi.fn(async () => ({ session: fakeSession(), runtime_id: "rt_1" })),
    } as unknown as DispatchService,
    chatResolver: {
      register: vi.fn(async () => fakeSession()),
    } as unknown as ChatResolver,
    hub: { isOnline: vi.fn(() => true) } as unknown as DaemonHub,
    ...overrides,
  };
}

/**
 * Stand-in for `createAuthMiddleware`. The real one resolves a bv_
 * token against Postgres; these tests only care about the caller shape
 * `requireHuman` gates on, so the source is set per-app.
 */
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

function makeApp(ports: Ports, source: "human" | "agent" | "none" = "human") {
  const app = express();
  app.use(json());
  app.use(
    "/chat",
    createChatRouter({
      authMiddleware: stubAuth(source),
      ...ports,
    } as ChatRoutesDeps),
  );
  return app;
}

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /chat/conversations", () => {
  it("403s a non-human caller", async () => {
    const res = await request(makeApp(makePorts(), "agent")).get("/chat/conversations");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const ports = makePorts({
      agentRepo: { findTopLevelForOwner: vi.fn(async () => undefined) } as unknown as AgentRepository,
    });
    const res = await request(makeApp(ports)).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    // No agent → no history query at all.
    expect(ports.sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain: title from the head, turn count, tail timestamp + preview", async () => {
    const head = fakeChat({
      id: "sess_head",
      intent: "plan the launch",
      result_summary: "Planned.",
      created_at: new Date("2026-03-01T10:00:00Z"),
    });
    const tail = fakeChat({
      id: "sess_tail",
      prior_session_id: "sess_head",
      intent: "and the docs?",
      result_summary: "Docs drafted.",
      created_at: new Date("2026-03-01T10:05:00Z"),
    });
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [tail, head]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head",
        title: "plan the launch",
        turn_count: 2,
        last_at: "2026-03-01T10:05:00.000Z",
        last_preview: "Docs drafted.",
      },
    ]);
  });

  it("truncates a long head intent into the thread title", async () => {
    const long = "x".repeat(200);
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [fakeChat({ id: "sess_h", intent: long })]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat/conversations");
    // CHAT_THREAD_TITLE_MAX is 80; truncate keeps n-1 chars + ellipsis.
    expect(res.body.conversations[0].title).toHaveLength(80);
    expect(res.body.conversations[0].title.endsWith("…")).toBe(true);
  });

  it("previews the error when a failed tail has no summary, and collapses whitespace", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          fakeChat({ id: "sess_h", status: "failed", error: "boom\n  on   line 2" }),
        ]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat/conversations");
    expect(res.body.conversations[0].last_preview).toBe("boom on line 2");
  });

  it("falls back to the intent for a preview when neither summary nor error is set", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          fakeChat({ id: "sess_h", intent: "just asking", status: "running" }),
        ]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat/conversations");
    expect(res.body.conversations[0].last_preview).toBe("just asking");
  });

  it("ellipsizes a preview longer than the 140-char budget", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [
          fakeChat({ id: "sess_h", result_summary: "y".repeat(400) }),
        ]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat/conversations");
    const preview = res.body.conversations[0].last_preview as string;
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("caps the list at 50 conversations", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      fakeChat({
        id: `sess_${i}`,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, i)),
      }),
    );
    const ports = makePorts({
      sessionRepo: { listChatForAgent: vi.fn(async () => many) } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat/conversations");
    expect(res.body.conversations).toHaveLength(50);
    // Newest-first, so the 60th (latest) chain leads.
    expect(res.body.conversations[0].head_id).toBe("sess_59");
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /chat/conversations/:headId", () => {
  it("403s a non-human caller", async () => {
    const res = await request(makeApp(makePorts(), "none")).delete("/chat/conversations/sess_h");
    expect(res.status).toBe(403);
  });

  it("404s when the caller has no primary agent", async () => {
    const ports = makePorts({
      agentRepo: { findTopLevelForOwner: vi.fn(async () => undefined) } as unknown as AgentRepository,
    });
    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_h");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
  });

  it("soft-deletes the chain scoped to the caller's agent and reports the row count", async () => {
    const softDeleteChatChain = vi.fn(async () => 3);
    const ports = makePorts({
      sessionRepo: { softDeleteChatChain } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    // Agent-scoped: a session id collision can't delete someone else's history.
    expect(softDeleteChatChain).toHaveBeenCalledWith("sess_head", AGENT);
  });

  it("is idempotent — re-deleting an already-deleted chain still 200s with 0", async () => {
    const ports = makePorts({
      sessionRepo: { softDeleteChatChain: vi.fn(async () => 0) } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("500s with a request_id and no internal detail when the repo throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ports = makePorts({
      sessionRepo: {
        softDeleteChatChain: vi.fn(async () => {
          throw new Error("pg: connection reset");
        }),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // The raw message stays in the logs, not on the wire.
    expect(JSON.stringify(res.body)).not.toContain("connection reset");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /chat", () => {
  it("403s a non-human caller", async () => {
    const res = await request(makeApp(makePorts(), "agent")).get("/chat");
    expect(res.status).toBe(403);
  });

  it("returns the null-agent shape when no primary agent exists", async () => {
    const ports = makePorts({
      agentRepo: { findTopLevelForOwner: vi.fn(async () => undefined) } as unknown as AgentRepository,
    });
    const res = await request(makeApp(ports)).get("/chat");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("returns the empty-state shape (not a 404) when the requested conversation doesn't exist", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [fakeChat({ id: "sess_other" })]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat").query({ c: "sess_missing" });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
    expect(res.body.agent).toEqual({ id: AGENT, name: "Alice's Team", hierarchy: "team" });
  });

  it("returns the empty-state shape when the agent has no chat sessions at all", async () => {
    const res = await request(makeApp(makePorts())).get("/chat");
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.prior_session_id).toBeNull();
  });

  it("rehydrates the most recent chain by default", async () => {
    const oldChain = fakeChat({
      id: "sess_old",
      intent: "old topic",
      result_summary: "old answer",
      created_at: new Date("2026-01-01T00:00:00Z"),
    });
    const newChain = fakeChat({
      id: "sess_new",
      intent: "new topic",
      result_summary: "new answer",
      created_at: new Date("2026-02-01T00:00:00Z"),
    });
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [oldChain, newChain]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat");
    expect(res.body.conversation_id).toBe("sess_new");
    expect(res.body.prior_session_id).toBe("sess_new");
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "new topic",
      "new answer",
    ]);
    expect(ports.sessionRepo.listChatForAgent).toHaveBeenCalledWith(AGENT, 400);
  });

  it("selects the requested chain via ?c=", async () => {
    const a = fakeChat({
      id: "sess_a",
      intent: "topic a",
      created_at: new Date("2026-01-01T00:00:00Z"),
    });
    const b = fakeChat({
      id: "sess_b",
      intent: "topic b",
      created_at: new Date("2026-02-01T00:00:00Z"),
    });
    const ports = makePorts({
      sessionRepo: { listChatForAgent: vi.fn(async () => [a, b]) } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat").query({ c: "sess_a" });
    expect(res.body.conversation_id).toBe("sess_a");
    expect(res.body.messages[0].content).toBe("topic a");
  });

  it("truncates a long chain to the last 25 sessions", async () => {
    // 40 turns chained head→tail; HISTORY_LIMIT/2 = 25 survive.
    const sessions = Array.from({ length: 40 }, (_, i) =>
      fakeChat({
        id: `sess_${i}`,
        ...(i > 0 ? { prior_session_id: `sess_${i - 1}` } : {}),
        intent: `turn ${i}`,
        result_summary: `reply ${i}`,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, i)),
      }),
    );
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => sessions),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat");
    // 25 sessions × (user + agent) = 50 messages, starting at turn 15.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].content).toBe("turn 15");
    // The chain head is still reported even though its turn was dropped.
    expect(res.body.conversation_id).toBe("sess_0");
    expect(res.body.prior_session_id).toBe("sess_39");
  });

  it("flags an in-flight tail session so the UI can resume its thinking indicator", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [fakeChat({ id: "sess_h", status: "running" })]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat");
    expect(res.body.in_flight_session_id).toBe("sess_h");
  });

  it("omits in_flight_session_id once the tail has reached a terminal status", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [fakeChat({ id: "sess_h", status: "succeeded" })]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("reports runtime_mismatch when the chain is pinned to a CLI the agent no longer uses", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [fakeChat({ id: "sess_h", runtime_id: "rt_old" })]),
      } as unknown as SessionRepository,
      runtimeRepo: {
        findById: vi.fn(async () => ({ id: "rt_old", cli: "codex" }) as Runtime),
      } as unknown as RuntimeRepository,
    });
    const res = await request(makeApp(ports)).get("/chat");
    expect(res.body.runtime_mismatch).toEqual({ pinned_cli: "codex", current_cli: "claude" });
  });

  it("omits runtime_mismatch when the pinned CLI matches the agent's current one", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [fakeChat({ id: "sess_h", runtime_id: "rt_1" })]),
      } as unknown as SessionRepository,
      runtimeRepo: {
        findById: vi.fn(async () => ({ id: "rt_1", cli: "claude" }) as Runtime),
      } as unknown as RuntimeRepository,
    });
    const res = await request(makeApp(ports)).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("omits runtime_mismatch for an unrecognized CLI string rather than surfacing garbage", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [fakeChat({ id: "sess_h", runtime_id: "rt_x" })]),
      } as unknown as SessionRepository,
      runtimeRepo: {
        findById: vi.fn(async () => ({ id: "rt_x", cli: "cursor" }) as Runtime),
      } as unknown as RuntimeRepository,
    });
    const res = await request(makeApp(ports)).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("skips the runtime lookup entirely when the tail session has no runtime_id", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [fakeChat({ id: "sess_h" })]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
    expect(ports.runtimeRepo.findById).not.toHaveBeenCalled();
  });

  it("omits runtime_mismatch when the pinned runtime row is gone", async () => {
    const ports = makePorts({
      sessionRepo: {
        listChatForAgent: vi.fn(async () => [fakeChat({ id: "sess_h", runtime_id: "rt_gone" })]),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports)).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
    expect(ports.runtimeRepo.findById).toHaveBeenCalledWith("rt_gone");
  });
});

// ── POST /chat ───────────────────────────────────────────────────────────

describe("POST /chat", () => {
  it("403s a non-human caller", async () => {
    const res = await request(makeApp(makePorts(), "agent"))
      .post("/chat")
      .send({ message: "hi" });
    expect(res.status).toBe(403);
  });

  it("400s on a missing message", async () => {
    const res = await request(makeApp(makePorts())).post("/chat").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
  });

  it("400s on a whitespace-only message", async () => {
    const res = await request(makeApp(makePorts())).post("/chat").send({ message: "   \n " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
  });

  it("400s on a non-string message", async () => {
    const res = await request(makeApp(makePorts())).post("/chat").send({ message: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
  });

  it("404s when the caller has no primary agent", async () => {
    const ports = makePorts({
      agentRepo: { findTopLevelForOwner: vi.fn(async () => undefined) } as unknown as AgentRepository,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("dispatches a fresh turn and returns the agent's response", async () => {
    const ports = makePorts({
      chatResolver: {
        register: vi.fn(async () =>
          fakeSession({ id: "sess_dispatched01", result_summary: "Sure thing." }),
        ),
      } as unknown as ChatResolver,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "  ship it  " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Alice's Team", hierarchy: "team" },
      session_id: "sess_dispatched01",
      response: "Sure thing.",
      status: "succeeded",
      view_refs: [],
    });
    expect(res.body.replayed).toBeUndefined();
    // Message is trimmed, and a first turn dispatches as `fresh`.
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      intent: "ship it",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
  });

  it("passes prior_session_id through as a chat_continuation resume reason", async () => {
    const ports = makePorts();
    await request(makeApp(ports))
      .post("/chat")
      .send({ message: "and then?", prior_session_id: "sess_prev" });
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_prev" },
      }),
    );
  });

  it("strips directives out of the response and surfaces them as structured fields", async () => {
    const ports = makePorts({
      chatResolver: {
        register: vi.fn(async () =>
          fakeSession({
            result_summary:
              'Done.<open_view path="/tasks" label="Tasks" />' +
              '<suggest_action label="Retry" prompt="try again" />',
          }),
        ),
      } as unknown as ChatResolver,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "go" });
    expect(res.body.response).toBe("Done.");
    expect(res.body.open_view).toEqual({ path: "/tasks", label: "Tasks" });
    expect(res.body.suggested_actions).toEqual([{ label: "Retry", prompt: "try again" }]);
  });

  it("maps a failed turn through failureMessageFor rather than echoing the bare CLI exit", async () => {
    const ports = makePorts({
      chatResolver: {
        register: vi.fn(async () =>
          fakeSession({ status: "failed", error: "CLI exited with code 1" }),
        ),
      } as unknown as ChatResolver,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "go" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.response).toContain("beevibe-daemon start");
  });

  // ── Idempotent replay ──────────────────────────────────────────────────

  it("replays a completed turn instead of spawning a second subprocess", async () => {
    const ports = makePorts({
      sessionRepo: {
        findById: vi.fn(async () =>
          fakeSession({
            id: VALID_CALLER_SESSION,
            type: "chat",
            status: "succeeded",
            result_summary: "Already answered.",
          }),
        ),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: VALID_CALLER_SESSION });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.response).toBe("Already answered.");
    // The whole point: no second dispatch, no second charge.
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed turn with the same friendlier failure message", async () => {
    const ports = makePorts({
      sessionRepo: {
        findById: vi.fn(async () =>
          fakeSession({
            id: VALID_CALLER_SESSION,
            status: "failed",
            error: "No runtime registered for dispatch payload type 'codex'",
          }),
        ),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: VALID_CALLER_SESSION });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.response).toContain("pinned to the codex runtime");
  });

  it("409s when the replayed session is still running", async () => {
    const ports = makePorts({
      sessionRepo: {
        findById: vi.fn(async () => fakeSession({ id: VALID_CALLER_SESSION, status: "running" })),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: VALID_CALLER_SESSION });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the session id collides with another caller's session", async () => {
    const ports = makePorts({
      sessionRepo: {
        findById: vi.fn(async () =>
          fakeSession({ id: VALID_CALLER_SESSION, agent_id: "agent_someone_else" }),
        ),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: VALID_CALLER_SESSION });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("falls through to a live dispatch when the pre-created row is still pending", async () => {
    // `tryReplay` returns { kind: 'skip' } for a non-terminal,
    // non-running row — the client claimed the id but nothing ran yet.
    const ports = makePorts({
      sessionRepo: {
        findById: vi.fn(async () => fakeSession({ id: VALID_CALLER_SESSION, status: "pending" })),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: VALID_CALLER_SESSION });
    expect(res.status).toBe(200);
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: VALID_CALLER_SESSION }),
    );
  });

  it("falls through to a live dispatch when the id belongs to a non-chat session", async () => {
    const ports = makePorts({
      sessionRepo: {
        findById: vi.fn(async () => fakeSession({ id: VALID_CALLER_SESSION, type: "task" })),
      } as unknown as SessionRepository,
    });
    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: VALID_CALLER_SESSION });
    expect(res.status).toBe(200);
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalled();
  });

  it("ignores a malformed session_id — no lookup, no override", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: "not-a-session-id" });
    expect(res.status).toBe(200);
    expect(ports.sessionRepo.findById).not.toHaveBeenCalled();
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: undefined }),
    );
  });

  // ── Rate limiting ──────────────────────────────────────────────────────

  it("429s a second concurrent turn with Retry-After and turn_in_flight", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    // Hold the only slot so the request below can't acquire one.
    const held = rateLimiter.acquire(PERSON);
    expect(held.ok).toBe(true);

    const res = await request(makeApp(makePorts({ rateLimiter })))
      .post("/chat")
      .send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("turn_in_flight");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.body.retry_after_ms).toBeGreaterThan(0);
  });

  it("429s with rate_limited once the sliding window is full", async () => {
    const rateLimiter = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 2,
      windowMs: 60_000,
      now: () => 1_000,
    });
    rateLimiter.acquire(PERSON);
    rateLimiter.acquire(PERSON);

    const res = await request(makeApp(makePorts({ rateLimiter })))
      .post("/chat")
      .send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
  });

  it("releases the rate-limit slot after a successful turn", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const app = makeApp(makePorts({ rateLimiter }));
    await request(app).post("/chat").send({ message: "one" });
    // If the first turn leaked its slot this would 429.
    const second = await request(app).post("/chat").send({ message: "two" });
    expect(second.status).toBe(200);
  });

  // ── Dispatch + daemon liveness ─────────────────────────────────────────

  it("503s when the session is bound to an offline daemon", async () => {
    const ports = makePorts({
      hub: { isOnline: vi.fn(() => false) } as unknown as DaemonHub,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(res.body.message).toContain("beevibe-daemon start");
    // Never registers a resolver it would just have to time out.
    expect(ports.chatResolver.register).not.toHaveBeenCalled();
  });

  it("proceeds without a liveness check for a null-runtime (executor fallback) dispatch", async () => {
    const ports = makePorts({
      dispatchService: {
        dispatchTask: vi.fn(async () => ({ session: fakeSession(), runtime_id: null })),
      } as unknown as DispatchService,
      hub: { isOnline: vi.fn(() => false) } as unknown as DaemonHub,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(ports.hub.isOnline).not.toHaveBeenCalled();
  });

  it("500s and frees the rate-limit slot when dispatch throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const ports = makePorts({
      rateLimiter,
      dispatchService: {
        dispatchTask: vi.fn(async () => {
          throw new Error("agent row vanished");
        }),
      } as unknown as DispatchService,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.request_id).toMatch(/^req_/);
    // Slot released — a stuck slot would lock the user out for good.
    expect(rateLimiter.acquire(PERSON).ok).toBe(true);
    spy.mockRestore();
  });

  it("frees the rate-limit slot on the 503 path too", async () => {
    const rateLimiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const ports = makePorts({
      rateLimiter,
      hub: { isOnline: vi.fn(() => false) } as unknown as DaemonHub,
    });
    await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(rateLimiter.acquire(PERSON).ok).toBe(true);
  });

  // ── Resolver outcomes ──────────────────────────────────────────────────

  it("504s when the resolver times out waiting for the daemon", async () => {
    const ports = makePorts({
      chatResolver: {
        register: vi.fn(async () => {
          throw new Error("chat resolver timeout (90000ms) for sess_x");
        }),
      } as unknown as ChatResolver,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(504);
    expect(res.body.error).toBe("chat_turn_timeout");
    expect(res.body.timeout_ms).toBe(90_000);
  });

  it("500s on a non-timeout resolver rejection", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ports = makePorts({
      chatResolver: {
        register: vi.fn(async () => {
          throw new Error("chat resolver already registered for sess_x");
        }),
      } as unknown as ChatResolver,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    spy.mockRestore();
  });

  it("registers the resolver against the dispatched session id with the 90s budget", async () => {
    const ports = makePorts({
      dispatchService: {
        dispatchTask: vi.fn(async () => ({
          session: fakeSession({ id: "sess_freshid0001" }),
          runtime_id: "rt_1",
        })),
      } as unknown as DispatchService,
    });
    await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(ports.chatResolver.register).toHaveBeenCalledWith("sess_freshid0001", 90_000);
  });

  // ── Onboarding flip ────────────────────────────────────────────────────

  it("stamps onboarding_completed_at on the first successful turn", async () => {
    const ports = makePorts({
      personRepo: {
        findById: vi.fn(async (id: string) => ({ id, name: "Alice" }) as Person),
        update: vi.fn(async () => undefined),
      } as unknown as PersonRepository,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(ports.personRepo.update).toHaveBeenCalledWith(PERSON, {
      onboarding_completed_at: expect.any(Date),
    });
  });

  it("does not re-stamp onboarding for a person who already completed it", async () => {
    const ports = makePorts();
    await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(ports.personRepo.update).not.toHaveBeenCalled();
  });

  it("does not stamp onboarding when the first turn fails", async () => {
    const ports = makePorts({
      personRepo: {
        findById: vi.fn(async (id: string) => ({ id, name: "Alice" }) as Person),
        update: vi.fn(async () => undefined),
      } as unknown as PersonRepository,
      chatResolver: {
        register: vi.fn(async () => fakeSession({ status: "failed", error: "nope" })),
      } as unknown as ChatResolver,
    });
    await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(ports.personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers the turn when the onboarding flip write fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ports = makePorts({
      personRepo: {
        findById: vi.fn(async (id: string) => ({ id, name: "Alice" }) as Person),
        update: vi.fn(async () => {
          throw new Error("pg: deadlock detected");
        }),
      } as unknown as PersonRepository,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    // Fire-and-forget: the write is best-effort, the turn is not.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    spy.mockRestore();
  });

  it("treats a missing person row as not-yet-onboarded without crashing the turn", async () => {
    const ports = makePorts({
      personRepo: {
        findById: vi.fn(async () => undefined),
        update: vi.fn(async () => undefined),
      } as unknown as PersonRepository,
    });
    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(ports.personRepo.update).toHaveBeenCalled();
  });
});
