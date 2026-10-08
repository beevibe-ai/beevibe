/**
 * /chat REST surface — unit tests with vitest fakes (no DB, no CLI).
 *
 * `createChatRouter` is a closure over seven ports, so a bag of
 * `vi.fn()` repos plus a stub auth middleware reaches every branch of
 * all four handlers: the conversations list, the soft-delete, the
 * history rehydrate (including runtime-mismatch detection and the
 * in-flight tail), and the POST turn — validation, idempotent replay,
 * rate limiting, daemon-offline 503, the resolver timeout 504, and the
 * onboarding flip.
 *
 * `groupIntoConversations` / `chainToMessages` / `failureMessageFor` are
 * unit-tested in `chat-internals.test.ts`; this suite drives them
 * through the HTTP surface so the wire shapes (field names, nesting,
 * which keys are omitted rather than null) are pinned too. `ChatResolver`
 * is faked as a bare promise factory — its own registry mechanics live
 * in `chat-resolver.test.ts` — and the rate limiter is injected with a
 * deterministic clock wherever a test cares about it.
 */
import express, { json } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  SYSTEM_WAKE_INTENT_CLOSE,
  SYSTEM_WAKE_INTENT_OPEN,
  type Agent,
  type AgentRepository,
  type Person,
  type PersonRepository,
  type Runtime,
  type RuntimeRepository,
  type Session,
  type SessionRepository,
} from "@beevibe/core";
import { runtimeMissingError } from "@beevibe/core/adapters/runtime-registry";
import type {
  DispatchInput,
  DispatchService,
} from "@beevibe/core/services/dispatch-service";
import type { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { createChatRouter, type ChatRoutesDeps } from "./chat.js";

const PERSON = "person_alice";
const AGENT = "agent_team";
const SESSION_ID = "sess_abcdefghijkl";

// ── Fixtures ─────────────────────────────────────────────────────────────

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
    name: "Alice",
    capability_network_enabled: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

let sessionSeq = 0;
function fakeSession(overrides: Partial<Session> = {}): Session {
  sessionSeq += 1;
  return {
    id: `sess_${String(sessionSeq).padStart(12, "0")}`,
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hi",
    created_at: new Date(Date.UTC(2026, 0, 1, 0, sessionSeq)),
    ...overrides,
  } as Session;
}

function fakeRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    id: "rt_1",
    daemon_id: "dmn_1",
    cli: "claude",
    capabilities: {},
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// ── Harness ──────────────────────────────────────────────────────────────

interface Opts {
  agent?: Agent | null;
  person?: Person | null;
  chats?: Session[];
  /** Row returned by sessionRepo.findById (the replay lookup). */
  existing?: Session | null;
  runtime?: Runtime | null;
  online?: boolean;
  /** Session the chat resolver settles with, or an Error it rejects with. */
  resolved?: Session | Error;
  dispatch?: { session: Session; runtime_id: string | null } | Error;
  deleted?: number;
  rateLimiter?: ChatRateLimiter;
  source?: "human" | "agent" | "none";
}

function harness(opts: Opts = {}) {
  const findTopLevelForOwner = vi.fn(async () =>
    opts.agent === undefined ? fakeAgent() : opts.agent,
  );
  const listChatForAgent = vi.fn(async () => opts.chats ?? []);
  const findSessionById = vi.fn(async () =>
    opts.existing === undefined ? undefined : opts.existing ?? undefined,
  );
  const softDeleteChatChain = vi.fn(async () => opts.deleted ?? 2);
  const findPersonById = vi.fn(async () =>
    opts.person === undefined ? fakePerson() : opts.person ?? undefined,
  );
  const personUpdate = vi.fn(async (_id: string, _patch: Partial<Person>) =>
    fakePerson(),
  );
  const findRuntimeById = vi.fn(async () =>
    opts.runtime === undefined ? undefined : opts.runtime ?? undefined,
  );
  const dispatchTask = vi.fn(async (_input: DispatchInput) => {
    if (opts.dispatch instanceof Error) throw opts.dispatch;
    return (
      opts.dispatch ?? {
        session: fakeSession({ id: SESSION_ID, status: "pending" }),
        runtime_id: null,
      }
    );
  });
  const register = vi.fn(async () => {
    if (opts.resolved instanceof Error) throw opts.resolved;
    return (
      opts.resolved ??
      fakeSession({ id: SESSION_ID, status: "succeeded", result_summary: "done" })
    );
  });
  const isOnline = vi.fn(() => opts.online ?? true);

  const deps: ChatRoutesDeps = {
    authMiddleware: stubAuth(opts.source ?? "human"),
    agentRepo: { findTopLevelForOwner } as unknown as AgentRepository,
    personRepo: {
      findById: findPersonById,
      update: personUpdate,
    } as unknown as PersonRepository,
    runtimeRepo: { findById: findRuntimeById } as unknown as RuntimeRepository,
    sessionRepo: {
      findById: findSessionById,
      listChatForAgent,
      softDeleteChatChain,
    } as unknown as SessionRepository,
    dispatchService: { dispatchTask } as unknown as DispatchService,
    chatResolver: { register } as unknown as ChatResolver,
    hub: { isOnline } as unknown as DaemonHub,
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
  };

  const app = express();
  app.use(json());
  app.use("/chat", createChatRouter(deps));

  return {
    app,
    findTopLevelForOwner,
    listChatForAgent,
    findSessionById,
    softDeleteChatChain,
    findPersonById,
    personUpdate,
    findRuntimeById,
    dispatchTask,
    register,
    isOnline,
  };
}

/**
 * Stand-in for `createAuthMiddleware`. The real one resolves a bv_ token
 * against Postgres; these tests only need the caller shape `requireHuman`
 * gates on.
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

// Silence the deliberate 500-path console.error so the suite output
// stays readable; the assertions check the response body instead.
function quietErrors() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /chat/conversations", () => {
  it("requires a human token on every route", async () => {
    for (const path of ["/chat/conversations", "/chat"]) {
      const res = await request(harness({ source: "agent" }).app).get(path);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("human_required");
    }
    const post = await request(harness({ source: "none" }).app)
      .post("/chat")
      .send({ message: "hi" });
    expect(post.status).toBe(403);
    const del = await request(harness({ source: "agent" }).app).delete(
      "/chat/conversations/sess_head",
    );
    expect(del.status).toBe(403);
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const h = harness({ agent: null });
    const res = await request(h.app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(h.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain with its head title, turn count and last preview", async () => {
    const head = fakeSession({
      id: "sess_head00000001",
      intent: "set up CI",
      result_summary: "starting",
      created_at: new Date("2026-02-01T10:00:00Z"),
    });
    const tail = fakeSession({
      id: "sess_tail00000001",
      prior_session_id: head.id,
      intent: "and lint",
      result_summary: "CI   is\n green now",
      created_at: new Date("2026-02-01T10:05:00Z"),
    });
    const h = harness({ chats: [head, tail] });

    const res = await request(h.app).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: head.id,
        title: "set up CI",
        turn_count: 2,
        last_at: "2026-02-01T10:05:00.000Z",
        last_preview: "CI is green now",
      },
    ]);
    // Bounded read so a heavy history can't drag the page load.
    expect(h.listChatForAgent).toHaveBeenCalledWith(AGENT, 400);
  });

  it("truncates a long head intent to the thread-title ceiling", async () => {
    const h = harness({ chats: [fakeSession({ intent: "z".repeat(120) })] });
    const res = await request(h.app).get("/chat/conversations");
    expect(res.body.conversations[0].title).toHaveLength(80);
    expect(res.body.conversations[0].title.endsWith("…")).toBe(true);
  });

  it("truncates a long preview and strips directives from it", async () => {
    const h = harness({
      chats: [
        fakeSession({
          result_summary:
            '<open_view path="/tasks" /> ' + "y".repeat(200),
        }),
      ],
    });
    const res = await request(h.app).get("/chat/conversations");
    const preview = res.body.conversations[0].last_preview as string;
    expect(preview).toHaveLength(140);
    expect(preview).not.toContain("open_view");
  });

  it("falls back to the error, then the intent, when there's no summary", async () => {
    const withError = harness({
      chats: [fakeSession({ status: "failed", error: "spawn failed" })],
    });
    const a = await request(withError.app).get("/chat/conversations");
    expect(a.body.conversations[0].last_preview).toBe("spawn failed");

    const bare = harness({ chats: [fakeSession({ intent: "just asked" })] });
    const b = await request(bare.app).get("/chat/conversations");
    expect(b.body.conversations[0].last_preview).toBe("just asked");
  });

  it("orders conversations newest-activity first and caps the list at 50", async () => {
    const chats = Array.from({ length: 60 }, (_, i) =>
      fakeSession({
        id: `sess_c${String(i).padStart(11, "0")}`,
        intent: `turn ${i}`,
        created_at: new Date(Date.UTC(2026, 2, 1, 0, i)),
      }),
    );
    const res = await request(harness({ chats }).app).get("/chat/conversations");
    expect(res.body.conversations).toHaveLength(50);
    expect(res.body.conversations[0].title).toBe("turn 59");
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /chat/conversations/:headId", () => {
  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const h = harness({ deleted: 3 });
    const res = await request(h.app).delete("/chat/conversations/sess_head00000001");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(h.softDeleteChatChain).toHaveBeenCalledWith("sess_head00000001", AGENT);
  });

  it("is idempotent — a chain already gone returns 200 with deleted: 0", async () => {
    const res = await request(harness({ deleted: 0 }).app).delete(
      "/chat/conversations/sess_head00000001",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("404s when the caller has no primary agent", async () => {
    const h = harness({ agent: null });
    const res = await request(h.app).delete("/chat/conversations/sess_head00000001");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
    expect(h.softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("500s with a request_id when the repo throws", async () => {
    const spy = quietErrors();
    const h = harness();
    h.softDeleteChatChain.mockRejectedValueOnce(new Error("deadlock detected"));

    const res = await request(h.app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // The detail stays server-side, indexed by the id the client sees.
    expect(res.body.message).not.toContain("deadlock");
    expect(spy.mock.calls[0]?.[0]).toContain(res.body.request_id);
    spy.mockRestore();
  });

  it("logs the message when the thrown error carries no stack", async () => {
    const spy = quietErrors();
    const h = harness();
    const stackless = new Error("no stack here");
    stackless.stack = undefined;
    h.softDeleteChatChain.mockRejectedValueOnce(stackless);

    const res = await request(h.app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(500);
    expect(spy.mock.calls[0]?.[1]).toBe("no stack here");
    spy.mockRestore();
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /chat", () => {
  it("returns a null agent and empty history when nothing is provisioned", async () => {
    const res = await request(harness({ agent: null }).app).get("/chat");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("renders the empty state (not a 404) for a conversation id that doesn't exist", async () => {
    const h = harness({ chats: [fakeSession({ id: "sess_real00000001" })] });
    const res = await request(h.app).get("/chat").query({ c: "sess_nope00000001" });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
    expect(res.body.agent).toMatchObject({ id: AGENT, hierarchy: "team" });
  });

  it("returns the empty state when the caller has no chat sessions at all", async () => {
    const res = await request(harness({ chats: [] }).app).get("/chat");
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.prior_session_id).toBeNull();
  });

  it("rehydrates the most recent chain as user/agent message pairs", async () => {
    const head = fakeSession({
      id: "sess_head00000001",
      intent: "set up CI",
      result_summary: "Opened task_aaaaaaaaaaaa for it.",
      created_at: new Date("2026-02-01T10:00:00Z"),
    });
    const h = harness({ chats: [head] });

    const res = await request(h.app).get("/chat");

    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([
      { id: `u_${head.id}`, role: "user", content: "set up CI" },
      {
        id: `a_${head.id}`,
        role: "agent",
        content: "Opened task_aaaaaaaaaaaa for it.",
        session_id: head.id,
        view_refs: ["task_aaaaaaaaaaaa"],
      },
    ]);
    expect(res.body.prior_session_id).toBe(head.id);
    expect(res.body.conversation_id).toBe(head.id);
    expect(res.body.in_flight_session_id).toBeUndefined();
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("serves a specific chain when ?c= names its head", async () => {
    const older = fakeSession({
      id: "sess_old000000001",
      intent: "older thread",
      result_summary: "ok",
      created_at: new Date("2026-02-01T09:00:00Z"),
    });
    const newer = fakeSession({
      id: "sess_new000000001",
      intent: "newer thread",
      result_summary: "ok",
      created_at: new Date("2026-02-01T11:00:00Z"),
    });
    const h = harness({ chats: [older, newer] });

    const picked = await request(h.app).get("/chat").query({ c: older.id });
    expect(picked.body.conversation_id).toBe(older.id);
    expect(picked.body.messages[0].content).toBe("older thread");

    const latest = await request(h.app).get("/chat");
    expect(latest.body.conversation_id).toBe(newer.id);
  });

  it("surfaces an open_view directive and keeps it out of the visible text", async () => {
    const s = fakeSession({
      result_summary: '<open_view path="/tasks/task_aaaaaaaaaaaa" label="The task" />Done.',
    });
    const res = await request(harness({ chats: [s] }).app).get("/chat");
    const agentMsg = res.body.messages[1];
    expect(agentMsg.content).toBe("Done.");
    expect(agentMsg.open_view).toEqual({
      path: "/tasks/task_aaaaaaaaaaaa",
      label: "The task",
    });
  });

  it("surfaces suggested actions and repo cards from a history turn", async () => {
    const s = fakeSession({
      result_summary:
        "Try this one: https://github.com/yt-dlp/yt-dlp\n" +
        '<suggest_action label="Run it" prompt="use yt-dlp on my clip" />',
    });
    const res = await request(harness({ chats: [s] }).app).get("/chat");
    const agentMsg = res.body.messages[1];
    expect(agentMsg.suggested_actions).toEqual([
      { label: "Run it", prompt: "use yt-dlp on my clip" },
    ]);
    expect(agentMsg.repo_cards).toEqual([
      {
        repo_url: "https://github.com/yt-dlp/yt-dlp",
        owner: "yt-dlp",
        name: "yt-dlp",
      },
    ]);
  });

  it("emits a system message carrying the wake summary for a watch-fired turn", async () => {
    const s = fakeSession({
      intent: `${SYSTEM_WAKE_INTENT_OPEN}task_aaaaaaaaaaaa finished.\n\nDecide next steps.${SYSTEM_WAKE_INTENT_CLOSE}`,
      result_summary: "Reviewed it.",
    });
    const res = await request(harness({ chats: [s] }).app).get("/chat");
    expect(res.body.messages[0]).toEqual({
      id: `w_${s.id}`,
      role: "system",
      content: "task_aaaaaaaaaaaa finished.",
      session_id: s.id,
    });
  });

  it("renders a failed turn with the daemon stderr tail", async () => {
    const s = fakeSession({
      status: "failed",
      error: "ENOENT: claude not found",
      result_summary: "CLI exited with code 1",
    });
    const res = await request(harness({ chats: [s] }).app).get("/chat");
    expect(res.body.messages[1]).toMatchObject({
      role: "agent",
      content: "ENOENT: claude not found",
    });
  });

  it("rewrites a runtime-missing failure into install guidance", async () => {
    const s = fakeSession({
      status: "failed",
      error: runtimeMissingError("codex"),
    });
    const res = await request(harness({ chats: [s] }).app).get("/chat");
    const content = res.body.messages[1].content as string;
    expect(content).toContain("pinned to the codex runtime");
    expect(content).toContain("beevibe-daemon sync");
  });

  it("falls back to the daemon-log pointer when a failure carries nothing useful", async () => {
    const s = fakeSession({
      status: "failed",
      error: "CLI exited with code 1",
      result_summary: "CLI exited with code null",
    });
    const res = await request(harness({ chats: [s] }).app).get("/chat");
    expect(res.body.messages[1].content).toContain("beevibe-daemon start");
  });

  it("omits the agent message slot while a turn is still in flight, and flags the tail", async () => {
    const head = fakeSession({
      id: "sess_head00000001",
      intent: "first",
      result_summary: "answered",
      created_at: new Date("2026-02-01T10:00:00Z"),
    });
    const pending = fakeSession({
      id: "sess_live00000001",
      prior_session_id: head.id,
      intent: "second",
      status: "running",
      created_at: new Date("2026-02-01T10:01:00Z"),
    });
    const res = await request(harness({ chats: [head, pending] }).app).get("/chat");

    expect(res.body.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "agent",
      "user",
    ]);
    expect(res.body.in_flight_session_id).toBe(pending.id);
    expect(res.body.prior_session_id).toBe(pending.id);
  });

  it("truncates a long chain to the most recent turns", async () => {
    const chats: Session[] = [];
    let prior: string | undefined;
    for (let i = 0; i < 40; i += 1) {
      const s = fakeSession({
        id: `sess_t${String(i).padStart(11, "0")}`,
        intent: `turn ${i}`,
        result_summary: `reply ${i}`,
        ...(prior ? { prior_session_id: prior } : {}),
        created_at: new Date(Date.UTC(2026, 3, 1, 0, i)),
      });
      prior = s.id;
      chats.push(s);
    }
    const res = await request(harness({ chats }).app).get("/chat");
    // 25 sessions × 2 messages — the oldest 15 turns are dropped.
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].content).toBe("turn 15");
  });

  it("reports a runtime mismatch when the chain is pinned to another CLI", async () => {
    const s = fakeSession({ runtime_id: "rt_1", result_summary: "ok" });
    const h = harness({ chats: [s], runtime: fakeRuntime({ cli: "codex" }) });

    const res = await request(h.app).get("/chat");

    expect(h.findRuntimeById).toHaveBeenCalledWith("rt_1");
    expect(res.body.runtime_mismatch).toEqual({
      pinned_cli: "codex",
      current_cli: "claude",
    });
  });

  it.each([
    ["the pinned CLI matches the agent's", "claude", fakeRuntime({ cli: "claude" })],
    ["the runtime row is gone", "missing-row", null],
    ["the pinned cli isn't a known one", "unknown-cli", fakeRuntime({ cli: "nano" })],
  ])("reports no mismatch when %s", async (_label, _k, runtime) => {
    const s = fakeSession({ runtime_id: "rt_1", result_summary: "ok" });
    const res = await request(harness({ chats: [s], runtime }).app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("skips the runtime lookup entirely for an unpinned chain", async () => {
    const h = harness({ chats: [fakeSession({ result_summary: "ok" })] });
    await request(h.app).get("/chat");
    expect(h.findRuntimeById).not.toHaveBeenCalled();
  });

  it("ignores a non-string ?c= rather than treating it as a head id", async () => {
    const s = fakeSession({ result_summary: "ok" });
    const res = await request(harness({ chats: [s] }).app).get("/chat?c=a&c=b");
    expect(res.status).toBe(200);
    expect(res.body.conversation_id).toBe(s.id);
  });
});

// ── POST /chat ───────────────────────────────────────────────────────────

describe("POST /chat validation", () => {
  it.each([
    ["an absent body", undefined],
    ["no message key", {}],
    ["a blank message", { message: "   " }],
    ["a non-string message", { message: 42 }],
  ])("400s on %s", async (_label, body) => {
    const h = harness();
    const req = request(h.app).post("/chat");
    const res = await (body === undefined ? req.send() : req.send(body));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when no team or org agent is provisioned", async () => {
    const h = harness({ agent: null });
    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });
});

describe("POST /chat dispatch", () => {
  it("dispatches a fresh turn and returns the resolved reply", async () => {
    const h = harness({
      resolved: fakeSession({
        id: SESSION_ID,
        status: "succeeded",
        result_summary: "Filed task_aaaaaaaaaaaa.",
      }),
    });

    const res = await request(h.app).post("/chat").send({ message: "  file a task  " });

    expect(h.dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      intent: "file a task",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
    expect(h.register).toHaveBeenCalledWith(SESSION_ID, 90_000);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Alice's Team", hierarchy: "team" },
      session_id: SESSION_ID,
      response: "Filed task_aaaaaaaaaaaa.",
      status: "succeeded",
      view_refs: ["task_aaaaaaaaaaaa"],
    });
    expect(res.body.replayed).toBeUndefined();
  });

  it("surfaces directives from the live turn's reply", async () => {
    const h = harness({
      resolved: fakeSession({
        id: SESSION_ID,
        status: "succeeded",
        result_summary:
          '<open_view path="/sessions" />Have a look.\n' +
          '<suggest_action label="Open it" />\n' +
          '<repo_card repo_url="https://github.com/acme/tool" stars="12" language="Go" />',
      }),
    });

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.body.response).toBe("Have a look.");
    expect(res.body.open_view).toEqual({ path: "/sessions" });
    expect(res.body.suggested_actions).toEqual([{ label: "Open it" }]);
    expect(res.body.repo_cards).toEqual([
      {
        repo_url: "https://github.com/acme/tool",
        owner: "acme",
        name: "tool",
        stars: 12,
        language: "Go",
      },
    ]);
  });

  it("falls back to the session error when a non-failed turn has no summary", async () => {
    const h = harness({
      resolved: fakeSession({
        id: SESSION_ID,
        status: "cancelled",
        error: "turn was cancelled",
      }),
    });
    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.body).toMatchObject({ status: "cancelled", response: "turn was cancelled" });
  });

  it("returns an empty response rather than null when there's neither summary nor error", async () => {
    const h = harness({
      resolved: fakeSession({ id: SESSION_ID, status: "succeeded" }),
    });
    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.body.response).toBe("");
  });

  it("passes prior_session_id through as a chat_continuation resume reason", async () => {
    const h = harness();
    await request(h.app)
      .post("/chat")
      .send({ message: "and now lint", prior_session_id: "sess_prior0000001" });
    expect(h.dispatchTask.mock.calls[0]![0]).toMatchObject({
      reason: { kind: "chat_continuation", prior_session_id: "sess_prior0000001" },
    });
  });

  it("ignores a non-string prior_session_id", async () => {
    const h = harness();
    await request(h.app).post("/chat").send({ message: "hi", prior_session_id: 7 });
    expect(h.dispatchTask.mock.calls[0]![0]).toMatchObject({
      reason: { kind: "fresh" },
    });
  });

  it("honours a well-formed client session_id as the dispatch override", async () => {
    const h = harness();
    await request(h.app).post("/chat").send({ message: "hi", session_id: SESSION_ID });
    expect(h.findSessionById).toHaveBeenCalledWith(SESSION_ID);
    expect(h.dispatchTask.mock.calls[0]![0]).toMatchObject({
      sessionIdOverride: SESSION_ID,
    });
  });

  it.each(["sess_tooshort", "notasession", "sess_has-a-dash", ""])(
    "ignores the malformed client session_id %j without a replay lookup",
    async (session_id) => {
      const h = harness();
      await request(h.app).post("/chat").send({ message: "hi", session_id });
      expect(h.findSessionById).not.toHaveBeenCalled();
      expect(h.dispatchTask.mock.calls[0]![0]).toMatchObject({
        sessionIdOverride: undefined,
      });
    },
  );

  it("renders a failed turn with the friendlier failure message", async () => {
    const h = harness({
      resolved: fakeSession({
        id: SESSION_ID,
        status: "failed",
        error: runtimeMissingError("opencode"),
      }),
    });
    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.response).toContain("pinned to the opencode runtime");
  });

  it("503s when the dispatch bound a daemon that isn't online", async () => {
    const h = harness({
      dispatch: {
        session: fakeSession({ id: SESSION_ID, status: "pending" }),
        runtime_id: "rt_1",
      },
      online: false,
    });

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(h.isOnline).toHaveBeenCalledWith("rt_1");
    expect(h.register).not.toHaveBeenCalled();
  });

  it("proceeds for a null-runtime dispatch — the in-process executor claims it", async () => {
    const h = harness({
      dispatch: {
        session: fakeSession({ id: SESSION_ID, status: "pending" }),
        runtime_id: null,
      },
      online: false,
    });
    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(h.isOnline).not.toHaveBeenCalled();
    expect(h.register).toHaveBeenCalled();
  });

  it("releases the rate-limit slot when dispatch throws, and 500s", async () => {
    const spy = quietErrors();
    const limiter = new ChatRateLimiter({ maxConcurrent: 1 });
    const h = harness({ dispatch: new Error("agent has no runtime"), rateLimiter: limiter });

    const first = await request(h.app).post("/chat").send({ message: "hi" });
    expect(first.status).toBe(500);
    expect(first.body.error).toBe("internal_error");

    // Slot released, so a retry isn't rejected as concurrent.
    const second = await request(h.app).post("/chat").send({ message: "hi" });
    expect(second.status).toBe(500);
    spy.mockRestore();
  });

  it("500s on a non-Error dispatch throw, logging the stringified value", async () => {
    const spy = quietErrors();
    const h = harness({ dispatch: "not even an error" as unknown as Error });
    h.dispatchTask.mockRejectedValueOnce("not even an error");

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(spy.mock.calls[0]?.[1]).toBe("not even an error");
    spy.mockRestore();
  });

  it("504s when the resolver times out waiting for /runtime/done", async () => {
    const h = harness({ resolved: new Error("chat resolver timeout (90000ms) for sess_x") });
    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      error: "chat_turn_timeout",
      timeout_ms: 90_000,
    });
    expect(res.body.message).toContain("90s");
  });

  it("500s when the resolver rejects for any other reason", async () => {
    const spy = quietErrors();
    const h = harness({ resolved: new Error("resolver collision") });
    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    spy.mockRestore();
  });
});

describe("POST /chat idempotent replay", () => {
  it("replays a finished turn instead of spawning a second CLI", async () => {
    const h = harness({
      existing: fakeSession({
        id: SESSION_ID,
        status: "succeeded",
        result_summary: "already answered",
      }),
    });

    const res = await request(h.app)
      .post("/chat")
      .send({ message: "hi", session_id: SESSION_ID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      replayed: true,
      session_id: SESSION_ID,
      response: "already answered",
      status: "succeeded",
    });
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed turn with the mapped failure message", async () => {
    const h = harness({
      existing: fakeSession({
        id: SESSION_ID,
        status: "failed",
        error: "disk full",
      }),
    });
    const res = await request(h.app)
      .post("/chat")
      .send({ message: "hi", session_id: SESSION_ID });
    expect(res.body).toMatchObject({ replayed: true, response: "disk full" });
  });

  it("409s while the prior turn on that id is still running", async () => {
    const h = harness({
      existing: fakeSession({ id: SESSION_ID, status: "running" }),
    });
    const res = await request(h.app)
      .post("/chat")
      .send({ message: "hi", session_id: SESSION_ID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the id collides with another person's session", async () => {
    const h = harness({
      existing: fakeSession({ id: SESSION_ID, agent_id: "agent_someone_else" }),
    });
    const res = await request(h.app)
      .post("/chat")
      .send({ message: "hi", session_id: SESSION_ID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
    expect(h.dispatchTask).not.toHaveBeenCalled();
  });

  it("falls through to the run path for a pending row, a non-chat row, or no row", async () => {
    for (const existing of [
      fakeSession({ id: SESSION_ID, status: "pending" }),
      fakeSession({ id: SESSION_ID, type: "task" }),
      null,
    ]) {
      const h = harness({ existing });
      const res = await request(h.app)
        .post("/chat")
        .send({ message: "hi", session_id: SESSION_ID });
      expect(res.status).toBe(200);
      expect(res.body.replayed).toBeUndefined();
      expect(h.dispatchTask).toHaveBeenCalledTimes(1);
    }
  });
});

describe("POST /chat rate limiting", () => {
  it("429s with Retry-After once the sliding window is spent", async () => {
    const limiter = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 1,
      windowMs: 60_000,
      now: () => 1_000,
    });
    const h = harness({ rateLimiter: limiter });

    const first = await request(h.app).post("/chat").send({ message: "hi" });
    expect(first.status).toBe(200);

    const second = await request(h.app).post("/chat").send({ message: "hi again" });
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("rate_limited");
    expect(second.body.retry_after_ms).toBeGreaterThan(0);
    expect(Number(second.headers["retry-after"])).toBeGreaterThan(0);
    expect(h.dispatchTask).toHaveBeenCalledTimes(1);
  });

  it("429s with turn_in_flight when a concurrent turn holds the slot", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 10 });
    let release!: (s: Session) => void;
    const h = harness({ rateLimiter: limiter });
    h.register.mockImplementation(
      () => new Promise<Session>((resolve) => (release = resolve)),
    );

    // `.then()` is what actually fires a supertest request — keep the
    // promise so the turn is genuinely in flight while we send the second.
    const inFlight = request(h.app)
      .post("/chat")
      .send({ message: "first" })
      .then((r) => r.status);
    await vi.waitFor(() => expect(h.register).toHaveBeenCalled());

    const second = await request(h.app).post("/chat").send({ message: "second" });
    expect(second.status).toBe(429);
    expect(second.body.error).toBe("turn_in_flight");
    expect(Number(second.headers["retry-after"])).toBeGreaterThanOrEqual(0);

    release(fakeSession({ id: SESSION_ID, result_summary: "done" }));
    await expect(inFlight).resolves.toBe(200);
  });

  it("checks the rate limit only after the replay short-circuit", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 1 });
    const h = harness({
      rateLimiter: limiter,
      existing: fakeSession({ id: SESSION_ID, status: "succeeded", result_summary: "a" }),
    });

    for (let i = 0; i < 3; i += 1) {
      const res = await request(h.app)
        .post("/chat")
        .send({ message: "hi", session_id: SESSION_ID });
      expect(res.status).toBe(200);
      expect(res.body.replayed).toBe(true);
    }
  });
});

describe("POST /chat onboarding flip", () => {
  it("stamps onboarding_completed_at on the first successful turn", async () => {
    const h = harness({ person: fakePerson({ onboarding_completed_at: undefined }) });

    await request(h.app).post("/chat").send({ message: "hi" });

    await vi.waitFor(() => expect(h.personUpdate).toHaveBeenCalled());
    expect(h.personUpdate.mock.calls[0]![0]).toBe(PERSON);
    expect(h.personUpdate.mock.calls[0]![1]).toMatchObject({
      onboarding_completed_at: expect.any(Date),
    });
  });

  it("leaves the flag alone once onboarding is already complete", async () => {
    const h = harness({
      person: fakePerson({ onboarding_completed_at: new Date("2026-01-05T00:00:00Z") }),
    });
    await request(h.app).post("/chat").send({ message: "hi" });
    expect(h.personUpdate).not.toHaveBeenCalled();
  });

  it("doesn't flip the flag when the first turn failed", async () => {
    const h = harness({
      person: fakePerson({ onboarding_completed_at: undefined }),
      resolved: fakeSession({ id: SESSION_ID, status: "failed", error: "boom" }),
    });
    await request(h.app).post("/chat").send({ message: "hi" });
    expect(h.personUpdate).not.toHaveBeenCalled();
  });

  it("still answers the turn when the flag write rejects", async () => {
    const spy = quietErrors();
    const h = harness({ person: fakePerson({ onboarding_completed_at: undefined }) });
    h.personUpdate.mockRejectedValueOnce(new Error("write failed"));

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(
        spy.mock.calls.some((c) => String(c[0]).includes("onboarding_completed_at")),
      ).toBe(true),
    );
    spy.mockRestore();
  });

  it("stringifies a non-Error rejection from the flag write", async () => {
    const spy = quietErrors();
    const h = harness({ person: fakePerson({ onboarding_completed_at: undefined }) });
    h.personUpdate.mockRejectedValueOnce("pool exhausted");

    const res = await request(h.app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(spy.mock.calls.some((c) => c[1] === "pool exhausted")).toBe(true),
    );
    spy.mockRestore();
  });

  it("treats a missing person row as mid-onboarding", async () => {
    const h = harness({ person: null });
    await request(h.app).post("/chat").send({ message: "hi" });
    await vi.waitFor(() => expect(h.personUpdate).toHaveBeenCalled());
  });
});
