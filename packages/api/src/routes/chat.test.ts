/**
 * /chat REST surface — unit tests with vitest fakes (no DB, no daemon).
 *
 * `chat-internals.test.ts` already covers the exported pure helpers
 * (`groupIntoConversations`, `chainToMessages`, `failureMessageFor`).
 * This file covers the four route handlers around them, which were
 * previously only reachable through a live daemon:
 *
 *   GET    /chat/conversations      — the thread list
 *   DELETE /chat/conversations/:id  — soft-delete, scoped to the caller
 *   GET    /chat                    — rehydrate one thread (+ runtime pin)
 *   POST   /chat                     — one turn: validation, idempotent
 *                                      replay, rate limit, dispatch,
 *                                      daemon-offline 503, resolver
 *                                      await, 504 timeout, 500 envelope
 *
 * The router is a closure over eight ports, so a bag of `vi.fn()` repos
 * plus a stub auth middleware reaches every branch. `processResponse`,
 * `truncate` and `failureMessageFor` run for real — their output is part
 * of the wire contract these tests pin.
 */
import express, { json } from "express";
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
import { createChatRouter, type ChatRoutesDeps } from "./chat.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const PERSON = "person_alice";
const AGENT = "agent_alicesteam";

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
  };
}

function fakePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: PERSON,
    email: "alice@example.com",
    name: "Alice",
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as Person;
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_aaaaaaaaaaaa",
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-01-01T10:00:00Z"),
    updated_at: new Date("2026-01-01T10:00:00Z"),
    ...overrides,
  } as Session;
}

// ── Harness ──────────────────────────────────────────────────────────────

interface Ports {
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

function ports(overrides: Partial<Ports> = {}): Ports {
  return {
    findTopLevelForOwner: vi.fn().mockResolvedValue(fakeAgent()),
    personFindById: vi
      .fn()
      .mockResolvedValue(
        fakePerson({ onboarding_completed_at: new Date("2026-01-01") } as Partial<Person>),
      ),
    personUpdate: vi.fn().mockResolvedValue(undefined),
    runtimeFindById: vi.fn().mockResolvedValue(null),
    listChatForAgent: vi.fn().mockResolvedValue([]),
    softDeleteChatChain: vi.fn().mockResolvedValue(0),
    sessionFindById: vi.fn().mockResolvedValue(null),
    dispatchTask: vi
      .fn()
      .mockResolvedValue({ session: fakeSession({ status: "running" }), runtime_id: null }),
    register: vi.fn().mockResolvedValue(fakeSession({ result_summary: "hi there" })),
    isOnline: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

/** Stand-in for `createAuthMiddleware`; only the caller shape matters. */
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
      req.caller = { source: "agent", agentId: AGENT, hierarchyLevel: "team" };
    }
    next();
  };
}

function makeApp(
  p: Ports,
  opts: { source?: "human" | "agent" | "none"; rateLimiter?: ChatRateLimiter } = {},
) {
  const deps: ChatRoutesDeps = {
    authMiddleware: stubAuth(opts.source ?? "human"),
    agentRepo: {
      findTopLevelForOwner: p.findTopLevelForOwner,
    } as unknown as AgentRepository,
    personRepo: {
      findById: p.personFindById,
      update: p.personUpdate,
    } as unknown as PersonRepository,
    runtimeRepo: { findById: p.runtimeFindById } as unknown as RuntimeRepository,
    sessionRepo: {
      listChatForAgent: p.listChatForAgent,
      softDeleteChatChain: p.softDeleteChatChain,
      findById: p.sessionFindById,
    } as unknown as SessionRepository,
    dispatchService: { dispatchTask: p.dispatchTask } as unknown as DispatchService,
    chatResolver: { register: p.register } as unknown as ChatResolver,
    hub: { isOnline: p.isOnline } as unknown as DaemonHub,
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
  };
  const app = express();
  app.use(json());
  app.use("/chat", createChatRouter(deps));
  return app;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── The human gate ───────────────────────────────────────────────────────

describe("the human gate", () => {
  it.each([
    ["GET", "/chat/conversations"],
    ["DELETE", "/chat/conversations/sess_head"],
    ["GET", "/chat"],
    ["POST", "/chat"],
  ])("403s an agent caller on %s %s", async (method, path) => {
    const app = makeApp(ports(), { source: "agent" });
    const verb = method.toLowerCase() as "get" | "post" | "delete";
    const res = await request(app)[verb](path).send({ message: "hi" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("403s an unauthenticated caller", async () => {
    const app = makeApp(ports(), { source: "none" });
    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(403);
  });
});

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /chat/conversations", () => {
  it("returns an empty list when the caller has no primary agent", async () => {
    const p = ports({ findTopLevelForOwner: vi.fn().mockResolvedValue(null) });
    const res = await request(makeApp(p)).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(p.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain: title from the head, preview + turn count from the tail", async () => {
    const head = fakeSession({
      id: "sess_head",
      intent: "set up CI",
      created_at: new Date("2026-01-01T10:00:00Z"),
    });
    const tail = fakeSession({
      id: "sess_tail",
      prior_session_id: "sess_head",
      intent: "now add caching",
      result_summary: "Added a cache step.",
      created_at: new Date("2026-01-01T10:05:00Z"),
    });
    const p = ports({ listChatForAgent: vi.fn().mockResolvedValue([tail, head]) });
    const res = await request(makeApp(p)).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head",
        title: "set up CI",
        turn_count: 2,
        last_at: "2026-01-01T10:05:00.000Z",
        last_preview: "Added a cache step.",
      },
    ]);
    expect(p.listChatForAgent).toHaveBeenCalledWith(AGENT, 400);
  });

  it("orders chains newest-first and caps the list at 50", async () => {
    // 60 single-turn chains, oldest first on the way in.
    const sessions = Array.from({ length: 60 }, (_, i) =>
      fakeSession({
        id: `sess_${String(i).padStart(12, "0")}`,
        intent: `turn ${i}`,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, i)),
      }),
    );
    const p = ports({ listChatForAgent: vi.fn().mockResolvedValue(sessions) });
    const res = await request(makeApp(p)).get("/chat/conversations");
    expect(res.body.conversations).toHaveLength(50);
    expect(res.body.conversations[0].title).toBe("turn 59");
  });

  it("falls back to the error, then the intent, for a turn with no summary", async () => {
    const failed = fakeSession({
      id: "sess_f",
      intent: "deploy it",
      status: "failed",
      error: "spawn claude ENOENT",
    });
    const bare = fakeSession({
      id: "sess_b",
      intent: "just the intent",
      created_at: new Date("2026-01-01T09:00:00Z"),
    });
    const p = ports({ listChatForAgent: vi.fn().mockResolvedValue([failed, bare]) });
    const res = await request(makeApp(p)).get("/chat/conversations");
    const byHead = Object.fromEntries(
      res.body.conversations.map((c: { head_id: string; last_preview: string }) => [
        c.head_id,
        c.last_preview,
      ]),
    );
    expect(byHead.sess_f).toBe("spawn claude ENOENT");
    expect(byHead.sess_b).toBe("just the intent");
  });

  it("collapses whitespace and ellipsizes a long preview", async () => {
    const long = fakeSession({
      id: "sess_long",
      result_summary: `line one\n\n${"x".repeat(300)}`,
    });
    const p = ports({ listChatForAgent: vi.fn().mockResolvedValue([long]) });
    const res = await request(makeApp(p)).get("/chat/conversations");
    const preview: string = res.body.conversations[0].last_preview;
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).not.toContain("\n");
  });

  it("strips directives out of the preview", async () => {
    const s = fakeSession({
      id: "sess_d",
      result_summary: 'Done.\n<suggest_action label="Next" />',
    });
    const p = ports({ listChatForAgent: vi.fn().mockResolvedValue([s]) });
    const res = await request(makeApp(p)).get("/chat/conversations");
    expect(res.body.conversations[0].last_preview).toBe("Done.");
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /chat/conversations/:headId", () => {
  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const p = ports({ softDeleteChatChain: vi.fn().mockResolvedValue(3) });
    const res = await request(makeApp(p)).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(p.softDeleteChatChain).toHaveBeenCalledWith("sess_head", AGENT);
  });

  it("is idempotent — re-deleting reports zero rows, not an error", async () => {
    const p = ports({ softDeleteChatChain: vi.fn().mockResolvedValue(0) });
    const res = await request(makeApp(p)).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("404s when the caller has no primary agent", async () => {
    const p = ports({ findTopLevelForOwner: vi.fn().mockResolvedValue(null) });
    const res = await request(makeApp(p)).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
    expect(p.softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("500s with a request id when the delete throws", async () => {
    const p = ports({
      softDeleteChatChain: vi.fn().mockRejectedValue(new Error("deadlock detected")),
    });
    const res = await request(makeApp(p)).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // The internal detail stays in the log, not the response body.
    expect(JSON.stringify(res.body)).not.toContain("deadlock");
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /chat", () => {
  it("returns a null agent and no messages when none is provisioned", async () => {
    const p = ports({ findTopLevelForOwner: vi.fn().mockResolvedValue(null) });
    const res = await request(makeApp(p)).get("/chat");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("rehydrates the most recent chain by default", async () => {
    const older = fakeSession({
      id: "sess_older000000",
      intent: "old thread",
      result_summary: "old answer",
      created_at: new Date("2026-01-01T09:00:00Z"),
    });
    const newer = fakeSession({
      id: "sess_newer000000",
      intent: "new thread",
      result_summary: "new answer",
      created_at: new Date("2026-01-01T10:00:00Z"),
    });
    const p = ports({ listChatForAgent: vi.fn().mockResolvedValue([older, newer]) });
    const res = await request(makeApp(p)).get("/chat");
    expect(res.body.conversation_id).toBe("sess_newer000000");
    expect(res.body.prior_session_id).toBe("sess_newer000000");
    expect(res.body.agent).toEqual({
      id: AGENT,
      name: "Alice's Team",
      hierarchy: "team",
    });
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "new thread",
      "new answer",
    ]);
  });

  it("honors ?c= to select an older chain", async () => {
    const older = fakeSession({
      id: "sess_older000000",
      intent: "old thread",
      created_at: new Date("2026-01-01T09:00:00Z"),
    });
    const newer = fakeSession({
      id: "sess_newer000000",
      intent: "new thread",
      created_at: new Date("2026-01-01T10:00:00Z"),
    });
    const p = ports({ listChatForAgent: vi.fn().mockResolvedValue([older, newer]) });
    const res = await request(makeApp(p)).get("/chat?c=sess_older000000");
    expect(res.body.conversation_id).toBe("sess_older000000");
  });

  it("renders the empty state (not a 404) for an unknown ?c=", async () => {
    const p = ports({
      listChatForAgent: vi.fn().mockResolvedValue([fakeSession({ id: "sess_a" })]),
    });
    const res = await request(makeApp(p)).get("/chat?c=sess_nope");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Alice's Team", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("renders the empty state when the agent has no chat sessions at all", async () => {
    const res = await request(makeApp(ports())).get("/chat");
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
  });

  it("truncates a long chain to the last 25 turns", async () => {
    // 30 chained turns; HISTORY_LIMIT/2 = 25 sessions survive.
    const sessions = Array.from({ length: 30 }, (_, i) =>
      fakeSession({
        id: `sess_${String(i).padStart(12, "0")}`,
        prior_session_id: i === 0 ? undefined : `sess_${String(i - 1).padStart(12, "0")}`,
        intent: `turn ${i}`,
        result_summary: `answer ${i}`,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, i)),
      }),
    );
    const p = ports({ listChatForAgent: vi.fn().mockResolvedValue(sessions) });
    const res = await request(makeApp(p)).get("/chat");
    expect(res.body.messages).toHaveLength(50); // 25 sessions × 2 messages
    expect(res.body.messages[0].content).toBe("turn 5");
    // The chain id still points at the real head, not the truncation point.
    expect(res.body.conversation_id).toBe("sess_000000000000");
  });

  it("renders a failed turn in history through the friendly failure mapping", async () => {
    const p = ports({
      listChatForAgent: vi.fn().mockResolvedValue([
        fakeSession({
          id: "sess_failed0000",
          intent: "deploy it",
          status: "failed",
          error: "Error: claude runtime not installed",
        }),
      ]),
    });
    const res = await request(makeApp(p)).get("/chat");
    expect(
      res.body.messages.map((m: { role: string; content: string }) => [
        m.role,
        m.content,
      ]),
    ).toEqual([
      ["user", "deploy it"],
      ["agent", "Error: claude runtime not installed"],
    ]);
  });

  it("emits a system message for a watch-fired wake turn", async () => {
    const p = ports({
      listChatForAgent: vi.fn().mockResolvedValue([
        fakeSession({
          id: "sess_wake000000",
          intent: "<system-wake>task_a finished\n\nDecide next steps.</system-wake>",
          result_summary: "Both tasks are done.",
        }),
      ]),
    });
    const res = await request(makeApp(p)).get("/chat");
    expect(
      res.body.messages.map((m: { role: string; content: string }) => [
        m.role,
        m.content,
      ]),
    ).toEqual([
      ["system", "task_a finished"],
      ["agent", "Both tasks are done."],
    ]);
  });

  it("leaves the agent reply slot empty while a turn is still in flight", async () => {
    const p = ports({
      listChatForAgent: vi.fn().mockResolvedValue([
        fakeSession({ id: "sess_pending000", intent: "do it", status: "running" }),
      ]),
    });
    const res = await request(makeApp(p)).get("/chat");
    expect(res.body.messages).toEqual([
      { id: "u_sess_pending000", role: "user", content: "do it" },
    ]);
  });

  it("surfaces in_flight_session_id while the tail turn is still running", async () => {
    const p = ports({
      listChatForAgent: vi
        .fn()
        .mockResolvedValue([fakeSession({ id: "sess_running0000", status: "running" })]),
    });
    const res = await request(makeApp(p)).get("/chat");
    expect(res.body.in_flight_session_id).toBe("sess_running0000");
  });

  it("omits in_flight_session_id for a terminal tail turn", async () => {
    const res = await request(
      makeApp(ports({ listChatForAgent: vi.fn().mockResolvedValue([fakeSession()]) })),
    ).get("/chat");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  describe("runtime pin mismatch", () => {
    const pinned = (cli: string) =>
      vi.fn().mockResolvedValue({ id: "rt_1", cli } as unknown as Runtime);

    it("flags a chain pinned to a different CLI than the agent now uses", async () => {
      const p = ports({
        listChatForAgent: vi
          .fn()
          .mockResolvedValue([fakeSession({ runtime_id: "rt_1" })]),
        runtimeFindById: pinned("codex"),
      });
      const res = await request(makeApp(p)).get("/chat");
      expect(res.body.runtime_mismatch).toEqual({
        pinned_cli: "codex",
        current_cli: "claude",
      });
      expect(p.runtimeFindById).toHaveBeenCalledWith("rt_1");
    });

    it("stays silent when the pin matches the agent's current CLI", async () => {
      const p = ports({
        listChatForAgent: vi
          .fn()
          .mockResolvedValue([fakeSession({ runtime_id: "rt_1" })]),
        runtimeFindById: pinned("claude"),
      });
      const res = await request(makeApp(p)).get("/chat");
      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it("stays silent for an unrecognized CLI on the runtime row", async () => {
      const p = ports({
        listChatForAgent: vi
          .fn()
          .mockResolvedValue([fakeSession({ runtime_id: "rt_1" })]),
        runtimeFindById: pinned("some-future-cli"),
      });
      const res = await request(makeApp(p)).get("/chat");
      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it("stays silent when the runtime row is gone", async () => {
      const p = ports({
        listChatForAgent: vi
          .fn()
          .mockResolvedValue([fakeSession({ runtime_id: "rt_gone" })]),
        runtimeFindById: vi.fn().mockResolvedValue(null),
      });
      const res = await request(makeApp(p)).get("/chat");
      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it("skips the lookup entirely for an unpinned chain", async () => {
      const p = ports({
        listChatForAgent: vi.fn().mockResolvedValue([fakeSession()]),
      });
      const res = await request(makeApp(p)).get("/chat");
      expect(res.body.runtime_mismatch).toBeUndefined();
      expect(p.runtimeFindById).not.toHaveBeenCalled();
    });
  });
});

// ── POST /chat ───────────────────────────────────────────────────────────

describe("POST /chat — validation", () => {
  it.each([
    ["an absent message", {}],
    ["a blank message", { message: "   " }],
    ["a non-string message", { message: 42 }],
  ])("400s %s without dispatching", async (_label, body) => {
    const p = ports();
    const res = await request(makeApp(p)).post("/chat").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
    expect(p.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const p = ports({ findTopLevelForOwner: vi.fn().mockResolvedValue(null) });
    const res = await request(makeApp(p)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
    expect(p.dispatchTask).not.toHaveBeenCalled();
  });
});

describe("POST /chat — dispatch", () => {
  it("dispatches a fresh chat turn and returns the resolved response", async () => {
    const p = ports({
      register: vi.fn().mockResolvedValue(
        fakeSession({ id: "sess_done00000", result_summary: "Here you go." }),
      ),
    });
    const res = await request(makeApp(p)).post("/chat").send({ message: "  hi  " });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Alice's Team", hierarchy: "team" },
      session_id: "sess_done00000",
      response: "Here you go.",
      status: "succeeded",
      view_refs: [],
    });
    expect(res.body.replayed).toBeUndefined();
    expect(p.dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      intent: "hi", // trimmed
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
  });

  it("passes prior_session_id as a chat_continuation so the CLI resumes", async () => {
    const p = ports();
    await request(makeApp(p))
      .post("/chat")
      .send({ message: "and now?", prior_session_id: "sess_prior00000" });
    expect(p.dispatchTask.mock.calls[0]?.[0].reason).toEqual({
      kind: "chat_continuation",
      prior_session_id: "sess_prior00000",
    });
  });

  it("forwards a well-formed client session_id as the override", async () => {
    const p = ports();
    await request(makeApp(p))
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abcdefghijkl" });
    expect(p.dispatchTask.mock.calls[0]?.[0].sessionIdOverride).toBe(
      "sess_abcdefghijkl",
    );
  });

  it("ignores a malformed client session_id rather than trusting it", async () => {
    const p = ports();
    await request(makeApp(p))
      .post("/chat")
      .send({ message: "hi", session_id: "not-a-session-id" });
    expect(p.dispatchTask.mock.calls[0]?.[0].sessionIdOverride).toBeUndefined();
    // And it never looked for a row to replay.
    expect(p.sessionFindById).not.toHaveBeenCalled();
  });

  it("lifts directives out of the response body", async () => {
    const p = ports({
      register: vi.fn().mockResolvedValue(
        fakeSession({
          result_summary:
            'Done.\n<open_view path="/tasks" label="Tasks" />\n<suggest_action label="Ship it" />',
        }),
      ),
    });
    const res = await request(makeApp(p)).post("/chat").send({ message: "hi" });
    expect(res.body.response).toBe("Done.");
    expect(res.body.open_view).toEqual({ path: "/tasks", label: "Tasks" });
    expect(res.body.suggested_actions).toEqual([{ label: "Ship it" }]);
  });

  it("renders a failed turn through the friendly failure mapping", async () => {
    const p = ports({
      register: vi.fn().mockResolvedValue(
        fakeSession({ status: "failed", error: "ENOENT: claude not found" }),
      ),
    });
    const res = await request(makeApp(p)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.response).toBe("ENOENT: claude not found");
  });

  it("falls back to the daemon-log pointer when a failed turn says nothing useful", async () => {
    const p = ports({
      register: vi.fn().mockResolvedValue(
        fakeSession({ status: "failed", error: "   " }),
      ),
    });
    const res = await request(makeApp(p)).post("/chat").send({ message: "hi" });
    expect(res.body.response).toContain("beevibe-daemon start");
  });
});

describe("POST /chat — daemon reachability", () => {
  it("503s when the dispatched session is bound to an offline daemon", async () => {
    const p = ports({
      dispatchTask: vi
        .fn()
        .mockResolvedValue({ session: fakeSession(), runtime_id: "rt_1" }),
      isOnline: vi.fn().mockReturnValue(false),
    });
    const res = await request(makeApp(p)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    // Don't hold the socket for 90s on a turn nothing will claim.
    expect(p.register).not.toHaveBeenCalled();
  });

  it("proceeds for a null-runtime agent (the in-process executor claims it)", async () => {
    const p = ports();
    const res = await request(makeApp(p)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(p.isOnline).not.toHaveBeenCalled();
  });

  it("releases the rate-limit slot on a 503 so the next turn isn't blocked", async () => {
    const p = ports({
      dispatchTask: vi
        .fn()
        .mockResolvedValue({ session: fakeSession(), runtime_id: "rt_1" }),
      isOnline: vi.fn().mockReturnValue(false),
    });
    const app = makeApp(p, { rateLimiter: new ChatRateLimiter({ maxConcurrent: 1 }) });
    expect((await request(app).post("/chat").send({ message: "hi" })).status).toBe(503);
    expect((await request(app).post("/chat").send({ message: "hi" })).status).toBe(503);
  });
});

describe("POST /chat — idempotent replay", () => {
  const CLIENT_SID = "sess_abcdefghijkl";

  it("replays a succeeded turn instead of spawning another subprocess", async () => {
    const p = ports({
      sessionFindById: vi.fn().mockResolvedValue(
        fakeSession({ id: CLIENT_SID, status: "succeeded", result_summary: "cached" }),
      ),
    });
    const res = await request(makeApp(p))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      session_id: CLIENT_SID,
      response: "cached",
      status: "succeeded",
      replayed: true,
    });
    expect(p.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed turn too, through the failure mapping", async () => {
    const p = ports({
      sessionFindById: vi.fn().mockResolvedValue(
        fakeSession({ id: CLIENT_SID, status: "failed", error: "boom" }),
      ),
    });
    const res = await request(makeApp(p))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "failed", response: "boom", replayed: true });
    expect(p.dispatchTask).not.toHaveBeenCalled();
  });

  it("409s a retry that lands while the turn is still running", async () => {
    const p = ports({
      sessionFindById: vi
        .fn()
        .mockResolvedValue(fakeSession({ id: CLIENT_SID, status: "running" })),
    });
    const res = await request(makeApp(p))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(p.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s a session id that belongs to someone else's agent", async () => {
    const p = ports({
      sessionFindById: vi
        .fn()
        .mockResolvedValue(fakeSession({ id: CLIENT_SID, agent_id: "agent_other" })),
    });
    const res = await request(makeApp(p))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
    expect(p.dispatchTask).not.toHaveBeenCalled();
  });

  it("runs the turn when the pre-minted row doesn't exist yet", async () => {
    const p = ports({ sessionFindById: vi.fn().mockResolvedValue(null) });
    const res = await request(makeApp(p))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });
    expect(res.status).toBe(200);
    expect(p.dispatchTask).toHaveBeenCalled();
  });

  it("runs the turn when the id belongs to a non-chat session", async () => {
    const p = ports({
      sessionFindById: vi
        .fn()
        .mockResolvedValue(fakeSession({ id: CLIENT_SID, type: "task" })),
    });
    const res = await request(makeApp(p))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });
    expect(res.status).toBe(200);
    expect(p.dispatchTask).toHaveBeenCalled();
  });

  it("runs the turn when the existing row is still pending (nothing to replay)", async () => {
    const p = ports({
      sessionFindById: vi
        .fn()
        .mockResolvedValue(fakeSession({ id: CLIENT_SID, status: "pending" })),
    });
    const res = await request(makeApp(p))
      .post("/chat")
      .send({ message: "hi", session_id: CLIENT_SID });
    expect(res.status).toBe(200);
    expect(p.dispatchTask).toHaveBeenCalled();
  });
});

describe("POST /chat — rate limiting", () => {
  it("429s a second concurrent turn with turn_in_flight and Retry-After", async () => {
    // Hold the first turn open so its slot is still taken.
    let release!: () => void;
    const p = ports({
      register: vi.fn().mockImplementation(
        () => new Promise((resolve) => {
          release = () => resolve(fakeSession({ result_summary: "done" }));
        }),
      ),
    });
    const app = makeApp(p, { rateLimiter: new ChatRateLimiter({ maxConcurrent: 1 }) });
    // `.then` is what actually fires a supertest request — without it the
    // first turn would never start and never hold the slot.
    const first = request(app)
      .post("/chat")
      .send({ message: "one" })
      .then((r) => r);
    // Let the first request reach the resolver await.
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    const second = await request(app).post("/chat").send({ message: "two" });
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("turn_in_flight");
    expect(second.body.retry_after_ms).toBeGreaterThanOrEqual(0);
    expect(second.headers["retry-after"]).toBeDefined();
    // Only the first turn was ever dispatched.
    expect(p.dispatchTask).toHaveBeenCalledTimes(1);

    release();
    expect((await first).status).toBe(200);
  });

  it("429s with rate_limited once the sliding window is full", async () => {
    const p = ports();
    const app = makeApp(p, {
      rateLimiter: new ChatRateLimiter({ maxConcurrent: 5, maxPerWindow: 2 }),
    });
    await request(app).post("/chat").send({ message: "one" });
    await request(app).post("/chat").send({ message: "two" });
    const third = await request(app).post("/chat").send({ message: "three" });
    expect(third.status).toBe(429);
    expect(third.body.error).toBe("rate_limited");
    expect(p.dispatchTask).toHaveBeenCalledTimes(2);
  });
});

describe("POST /chat — onboarding flip", () => {
  it("stamps onboarding_completed_at after the first successful turn", async () => {
    const p = ports({
      personFindById: vi.fn().mockResolvedValue(fakePerson()), // no flag yet
    });
    await request(makeApp(p)).post("/chat").send({ message: "hi" });
    await vi.waitFor(() => expect(p.personUpdate).toHaveBeenCalledTimes(1));
    expect(p.personUpdate.mock.calls[0]?.[0]).toBe(PERSON);
    expect(p.personUpdate.mock.calls[0]?.[1].onboarding_completed_at).toBeInstanceOf(
      Date,
    );
  });

  it("does not flip it on a failed first turn", async () => {
    const p = ports({
      personFindById: vi.fn().mockResolvedValue(fakePerson()),
      register: vi
        .fn()
        .mockResolvedValue(fakeSession({ status: "failed", error: "boom" })),
    });
    await request(makeApp(p)).post("/chat").send({ message: "hi" });
    expect(p.personUpdate).not.toHaveBeenCalled();
  });

  it("does not re-flip it for an already-onboarded person", async () => {
    const p = ports();
    await request(makeApp(p)).post("/chat").send({ message: "hi" });
    expect(p.personUpdate).not.toHaveBeenCalled();
  });

  it("still answers the turn when the flip write fails", async () => {
    const p = ports({
      personFindById: vi.fn().mockResolvedValue(fakePerson()),
      personUpdate: vi.fn().mockRejectedValue(new Error("write conflict")),
    });
    const res = await request(makeApp(p)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe("POST /chat — failure envelopes", () => {
  it("500s when dispatch throws, and frees the rate-limit slot", async () => {
    const p = ports({
      dispatchTask: vi.fn().mockRejectedValue(new Error("pool exhausted")),
    });
    const app = makeApp(p, { rateLimiter: new ChatRateLimiter({ maxConcurrent: 1 }) });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    expect(JSON.stringify(res.body)).not.toContain("pool exhausted");
    // Slot released: the retry gets past the limiter to the same 500.
    expect((await request(app).post("/chat").send({ message: "hi" })).status).toBe(500);
  });

  it("504s when the resolver times out waiting for /runtime/done", async () => {
    const p = ports({
      register: vi
        .fn()
        .mockRejectedValue(new Error("chat resolver timeout (90000ms) for sess_x")),
    });
    const res = await request(makeApp(p)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      error: "chat_turn_timeout",
      timeout_ms: 90_000,
    });
  });

  it("500s on any other resolver rejection", async () => {
    const p = ports({
      register: vi.fn().mockRejectedValue(new Error("resolver collision")),
    });
    const res = await request(makeApp(p)).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });
});
