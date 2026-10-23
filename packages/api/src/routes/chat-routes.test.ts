/**
 * `createChatRouter` — the four handlers behind `/chat`, with vitest
 * fakes and no DB. The pure helpers (`groupIntoConversations`,
 * `chainToMessages`, `failureMessageFor`) are covered in
 * chat-internals.test.ts; what's pinned here is everything the router
 * itself decides:
 *
 *   - `GET /conversations` — chain → list-item projection, preview
 *     fallback order, and the title/preview truncation rules.
 *   - `DELETE /conversations/:headId` — the agent scoping that keeps a
 *     head-id collision from deleting someone else's history.
 *   - `GET /` — which chain gets picked, the in-flight tail id the UI
 *     resumes its spinner from, and the runtime-pin mismatch flag.
 *   - `POST /` — the money path: idempotent replay, the per-person rate
 *     limit, the daemon-offline 503, the 90s timeout, the onboarding
 *     flip, and the rate-limit release on every exit.
 */
import express, { json } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { createChatRouter, type ChatRoutesDeps } from "./chat.js";

const PERSON = "person_1";
const AGENT = "agent_a";

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

/** Chat session rows as `listChatForAgent` hands them back. */
function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_aaaaaaaaaaaa",
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-04-01T10:00:00Z"),
    ...overrides,
  };
}

function fakeRuntime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    id: "rt_1",
    daemon_id: "dmn_1",
    cli: "claude",
    capabilities: {},
    created_at: new Date("2026-04-01"),
    ...overrides,
  };
}

interface Fakes {
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  runtimeRepo: RuntimeRepository;
  sessionRepo: SessionRepository;
  dispatchService: DispatchService;
  chatResolver: ChatResolver;
  hub: DaemonHub;
  rateLimiter?: ChatRateLimiter;
}

interface AppOpts {
  /** Primary agent for the caller; `null` means none provisioned. */
  agent?: Agent | null;
  /** `null` means no person row on file; omitted means an onboarded one. */
  person?: Person | null;
  chats?: Session[];
  /** Row `tryReplay` finds for a passed-in `session_id`. */
  existingSession?: Session | undefined;
  runtime?: Runtime | undefined;
  /** What `dispatchTask` resolves (or rejects) with. */
  dispatch?: () => Promise<{ session: Session; runtime_id: string | null }>;
  /** What the resolver settles with once the daemon posts terminal state. */
  resolve?: () => Promise<Session>;
  online?: boolean;
  softDeleted?: number | (() => Promise<number>);
  rateLimiter?: ChatRateLimiter;
  source?: "human" | "agent";
}

/**
 * Partial fakes cast to their port types — these handlers touch a
 * handful of methods out of repositories with twenty-plus.
 */
function makeFakes(opts: AppOpts): Fakes {
  const agent = opts.agent === undefined ? fakeAgent() : opts.agent;
  const dispatched = fakeSession({ id: "sess_bbbbbbbbbbbb", status: "pending" });

  const softDelete =
    typeof opts.softDeleted === "function"
      ? opts.softDeleted
      : async () => opts.softDeleted ?? 1;

  return {
    agentRepo: {
      findTopLevelForOwner: vi.fn(async () => agent ?? undefined),
    } as unknown as AgentRepository,
    personRepo: {
      findById: vi.fn(async () =>
        opts.person === undefined
          ? fakePerson({ onboarding_completed_at: new Date() })
          : (opts.person ?? undefined),
      ),
      update: vi.fn(async () => fakePerson()),
    } as unknown as PersonRepository,
    runtimeRepo: {
      findById: vi.fn(async () => opts.runtime),
    } as unknown as RuntimeRepository,
    sessionRepo: {
      listChatForAgent: vi.fn(async () => opts.chats ?? []),
      findById: vi.fn(async () => opts.existingSession),
      softDeleteChatChain: vi.fn(softDelete),
    } as unknown as SessionRepository,
    dispatchService: {
      dispatchTask: vi.fn(
        opts.dispatch ?? (async () => ({ session: dispatched, runtime_id: null })),
      ),
    } as unknown as DispatchService,
    chatResolver: {
      register: vi.fn(
        opts.resolve ??
          (async () => fakeSession({ id: dispatched.id, status: "succeeded", result_summary: "hi" })),
      ),
    } as unknown as ChatResolver,
    hub: {
      isOnline: vi.fn(() => opts.online ?? true),
    } as unknown as DaemonHub,
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
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

function makeApp(opts: AppOpts = {}): { app: express.Express; fakes: Fakes } {
  const fakes = makeFakes(opts);
  const app = express();
  app.use(json());
  app.use(
    "/chat",
    createChatRouter({
      authMiddleware: stubAuth(opts.source ?? "human"),
      ...fakes,
    } as ChatRoutesDeps),
  );
  return { app, fakes };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat routes — human-only gate", () => {
  it.each([
    ["get", "/chat/conversations"],
    ["get", "/chat"],
    ["post", "/chat"],
    ["delete", "/chat/conversations/sess_aaaaaaaaaaaa"],
  ] as const)("403s an agent-token caller on %s %s", async (method, path) => {
    const { app, fakes } = makeApp({ source: "agent" });
    const res = await request(app)[method](path);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "human_required" });
    expect(fakes.agentRepo.findTopLevelForOwner).not.toHaveBeenCalled();
  });
});

describe("GET /chat/conversations", () => {
  it("returns an empty list when the caller has no primary agent", async () => {
    const { app, fakes } = makeApp({ agent: null });

    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(fakes.sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("projects each chain to head id, title, turn count and last turn", async () => {
    const chats = [
      fakeSession({
        id: "sess_bbbbbbbbbbbb",
        prior_session_id: "sess_aaaaaaaaaaaa",
        intent: "and then?",
        result_summary: "the second answer",
        created_at: new Date("2026-04-01T11:00:00Z"),
      }),
      fakeSession({
        id: "sess_aaaaaaaaaaaa",
        intent: "how do I start?",
        result_summary: "the first answer",
      }),
    ];
    const { app, fakes } = makeApp({ chats });

    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_aaaaaaaaaaaa",
        title: "how do I start?",
        turn_count: 2,
        last_at: "2026-04-01T11:00:00.000Z",
        last_preview: "the second answer",
      },
    ]);
    // Bounded fetch — a heavy user's full history never lands in memory.
    expect(fakes.sessionRepo.listChatForAgent).toHaveBeenCalledWith(AGENT, 400);
  });

  it("truncates a long first-turn intent into the thread title", async () => {
    const { app } = makeApp({ chats: [fakeSession({ intent: "x".repeat(200) })] });

    const res = await request(app).get("/chat/conversations");
    const title = res.body.conversations[0].title as string;
    expect(title).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back from result_summary to error to intent for the preview", async () => {
    const cases: Array<[Partial<Session>, string]> = [
      [{ result_summary: "the answer", error: "ignored" }, "the answer"],
      [{ status: "failed", error: "it broke" }, "it broke"],
      [{ intent: "just the question" }, "just the question"],
    ];

    for (const [overrides, expected] of cases) {
      const { app } = makeApp({
        chats: [fakeSession({ result_summary: undefined, ...overrides })],
      });
      const res = await request(app).get("/chat/conversations");
      expect(res.body.conversations[0].last_preview).toBe(expected);
    }
  });

  it("strips directives and collapses whitespace in the preview", async () => {
    const { app } = makeApp({
      chats: [
        fakeSession({
          result_summary: 'Done.\n\n  Look here.<open_view path="/tasks" />',
        }),
      ],
    });

    const res = await request(app).get("/chat/conversations");
    expect(res.body.conversations[0].last_preview).toBe("Done. Look here.");
  });

  it("ellipsizes a preview past 140 chars", async () => {
    const { app } = makeApp({ chats: [fakeSession({ result_summary: "y".repeat(300) })] });

    const res = await request(app).get("/chat/conversations");
    const preview = res.body.conversations[0].last_preview as string;
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("caps the list at 50 conversations even when more exist", async () => {
    const chats = Array.from({ length: 60 }, (_, i) =>
      fakeSession({
        id: `sess_${String(i).padStart(12, "0")}`,
        intent: `turn ${i}`,
        created_at: new Date(Date.UTC(2026, 3, 1, 0, i)),
      }),
    );
    const { app } = makeApp({ chats });

    const res = await request(app).get("/chat/conversations");
    expect(res.body.conversations).toHaveLength(50);
  });
});

describe("DELETE /chat/conversations/:headId", () => {
  it("404s when the caller has no primary agent", async () => {
    const { app, fakes } = makeApp({ agent: null });

    const res = await request(app).delete("/chat/conversations/sess_aaaaaaaaaaaa");
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "agent_not_found" });
    expect(fakes.sessionRepo.softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("soft-deletes the chain scoped to the caller's own agent", async () => {
    const { app, fakes } = makeApp({ softDeleted: 3 });

    const res = await request(app).delete("/chat/conversations/sess_aaaaaaaaaaaa");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    // The agent id is the scope that stops a head-id collision from
    // deleting another person's history.
    expect(fakes.sessionRepo.softDeleteChatChain).toHaveBeenCalledWith(
      "sess_aaaaaaaaaaaa",
      AGENT,
    );
  });

  it("is idempotent — re-deleting an already-deleted chain is a 200 with 0", async () => {
    const { app } = makeApp({ softDeleted: 0 });

    const res = await request(app).delete("/chat/conversations/sess_aaaaaaaaaaaa");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("turns a repo failure into a 500 carrying a request id, not a stack", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({
      softDeleted: async () => {
        throw new Error("deadlock detected");
      },
    });

    const res = await request(app).delete("/chat/conversations/sess_aaaaaaaaaaaa");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    expect(JSON.stringify(res.body)).not.toContain("deadlock");
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("GET /chat", () => {
  it("returns a null agent and no messages when none is provisioned", async () => {
    const { app } = makeApp({ agent: null });

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

  it("returns the agent with an empty history when there are no chats yet", async () => {
    const { app } = makeApp({ chats: [] });

    const res = await request(app).get("/chat");
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Ada's team", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("renders the most recent chain's turns as user/agent message pairs", async () => {
    const { app } = makeApp({
      chats: [fakeSession({ intent: "hello", result_summary: "hi there" })],
    });

    const res = await request(app).get("/chat");
    expect(res.body.messages).toEqual([
      { id: "u_sess_aaaaaaaaaaaa", role: "user", content: "hello" },
      {
        id: "a_sess_aaaaaaaaaaaa",
        role: "agent",
        content: "hi there",
        session_id: "sess_aaaaaaaaaaaa",
      },
    ]);
    expect(res.body.prior_session_id).toBe("sess_aaaaaaaaaaaa");
    expect(res.body.conversation_id).toBe("sess_aaaaaaaaaaaa");
  });

  it("picks the chain named by ?c= rather than the newest one", async () => {
    const chats = [
      fakeSession({
        id: "sess_newnewnewne",
        intent: "newer thread",
        created_at: new Date("2026-04-02T10:00:00Z"),
      }),
      fakeSession({ id: "sess_oldoldoldol", intent: "older thread" }),
    ];
    const { app } = makeApp({ chats });

    const res = await request(app).get("/chat").query({ c: "sess_oldoldoldol" });
    expect(res.body.conversation_id).toBe("sess_oldoldoldol");
    expect(res.body.messages[0].content).toBe("older thread");

    // No ?c= → newest chain.
    const newest = await request(app).get("/chat");
    expect(newest.body.conversation_id).toBe("sess_newnewnewne");
  });

  it("renders the empty state, not a 404, for an unknown ?c=", async () => {
    const { app } = makeApp({ chats: [fakeSession()] });

    const res = await request(app).get("/chat").query({ c: "sess_nosuchchain" });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
  });

  it("ignores a non-string ?c= and falls back to the newest chain", async () => {
    const { app } = makeApp({ chats: [fakeSession()] });

    const res = await request(app).get("/chat?c=a&c=b");
    expect(res.body.conversation_id).toBe("sess_aaaaaaaaaaaa");
  });

  it.each(["pending", "running"] as const)(
    "surfaces an in-flight tail (%s) so the UI can resume its spinner",
    async (status) => {
      const { app } = makeApp({
        chats: [fakeSession({ status, result_summary: undefined })],
      });

      const res = await request(app).get("/chat");
      expect(res.body.in_flight_session_id).toBe("sess_aaaaaaaaaaaa");
      // chainToMessages skips the empty reply slot — the user turn stands alone.
      expect(res.body.messages).toEqual([
        { id: "u_sess_aaaaaaaaaaaa", role: "user", content: "hello" },
      ]);
    },
  );

  it("omits in_flight_session_id once the tail is terminal", async () => {
    const { app } = makeApp({ chats: [fakeSession({ status: "succeeded" })] });

    const res = await request(app).get("/chat");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("emits a system message for a watch-fired wake turn", async () => {
    const { app } = makeApp({
      chats: [
        fakeSession({
          intent: `${SYSTEM_WAKE_INTENT_OPEN}deploy finished\n\nDecide next steps.${SYSTEM_WAKE_INTENT_CLOSE}`,
          result_summary: "I'll take it from here.",
        }),
      ],
    });

    const res = await request(app).get("/chat");
    expect(res.body.messages[0]).toEqual({
      id: "w_sess_aaaaaaaaaaaa",
      role: "system",
      content: "deploy finished",
      session_id: "sess_aaaaaaaaaaaa",
    });
  });

  it("renders a failed turn in history with the friendly failure text", async () => {
    const { app } = makeApp({
      chats: [
        fakeSession({
          intent: "do the thing",
          status: "failed",
          result_summary: undefined,
          error: "CLI exited with code 1",
        }),
      ],
    });

    const res = await request(app).get("/chat");
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.messages[1]).toMatchObject({
      id: "a_sess_aaaaaaaaaaaa",
      role: "agent",
      session_id: "sess_aaaaaaaaaaaa",
    });
    // A bare CLI exit is useless to the reader; the pointer isn't.
    expect(res.body.messages[1].content).toContain("beevibe-daemon start");
  });

  it("prefers a real error over the result summary on a failed turn", async () => {
    const { app } = makeApp({
      chats: [
        fakeSession({
          status: "failed",
          result_summary: "partial output",
          error: "ENOSPC: no space left on device",
        }),
      ],
    });

    const res = await request(app).get("/chat");
    expect(res.body.messages[1].content).toBe("ENOSPC: no space left on device");
  });

  it("keeps the history to the newest 25 turns", async () => {
    // One chain of 40 turns, each linked to the previous.
    const chats = Array.from({ length: 40 }, (_, i) =>
      fakeSession({
        id: `sess_${String(i).padStart(12, "0")}`,
        ...(i > 0 ? { prior_session_id: `sess_${String(i - 1).padStart(12, "0")}` } : {}),
        intent: `turn ${i}`,
        result_summary: `answer ${i}`,
        created_at: new Date(Date.UTC(2026, 3, 1, 0, i)),
      }),
    );
    const { app } = makeApp({ chats });

    const res = await request(app).get("/chat");
    // 25 sessions × (user + agent).
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].content).toBe("turn 15");
    // prior_session_id still points at the real tail, not the window's edge.
    expect(res.body.prior_session_id).toBe("sess_000000000039");
  });

  it("flags a chain pinned to a CLI the agent no longer runs", async () => {
    const { app, fakes } = makeApp({
      agent: fakeAgent({ runtime_config: { type: "codex" } }),
      chats: [fakeSession({ runtime_id: "rt_1" })],
      runtime: fakeRuntime({ cli: "claude" }),
    });

    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toEqual({
      pinned_cli: "claude",
      current_cli: "codex",
    });
    expect(fakes.runtimeRepo.findById).toHaveBeenCalledWith("rt_1");
  });

  it("omits the mismatch flag when the pin matches, the row is gone, or the CLI is unknown", async () => {
    const cases: Array<[string, AppOpts]> = [
      ["pin matches", { runtime: fakeRuntime({ cli: "claude" }) }],
      ["runtime row gone", { runtime: undefined }],
      ["unrecognized cli", { runtime: fakeRuntime({ cli: "some-fork" }) }],
    ];

    for (const [, opts] of cases) {
      const { app } = makeApp({ chats: [fakeSession({ runtime_id: "rt_1" })], ...opts });
      const res = await request(app).get("/chat");
      expect(res.body.runtime_mismatch).toBeUndefined();
    }
  });

  it("skips the runtime lookup entirely for an unpinned chain", async () => {
    const { app, fakes } = makeApp({ chats: [fakeSession({ runtime_id: undefined })] });

    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
    expect(fakes.runtimeRepo.findById).not.toHaveBeenCalled();
  });
});

describe("POST /chat — input validation", () => {
  it.each([
    ["an absent message", {}],
    ["an empty message", { message: "" }],
    ["a whitespace-only message", { message: "   \n  " }],
    ["a non-string message", { message: 42 }],
  ])("400s %s without dispatching", async (_label, body) => {
    const { app, fakes } = makeApp();

    const res = await request(app).post("/chat").send(body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "message_required" });
    expect(fakes.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no team or org agent", async () => {
    const { app, fakes } = makeApp({ agent: null });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "no_primary_agent" });
    expect(fakes.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("trims the message before dispatching it", async () => {
    const { app, fakes } = makeApp();

    await request(app).post("/chat").send({ message: "  hello  " });
    expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "hello" }),
    );
  });
});

describe("POST /chat — idempotent replay", () => {
  const CALLER_SESSION = "sess_cccccccccccc";

  it("replays a finished turn instead of spawning another subprocess", async () => {
    const { app, fakes } = makeApp({
      existingSession: fakeSession({
        id: CALLER_SESSION,
        status: "succeeded",
        result_summary: "the cached answer",
      }),
    });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SESSION });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      replayed: true,
      session_id: CALLER_SESSION,
      response: "the cached answer",
      status: "succeeded",
    });
    // The whole point: no second dispatch, so no second charge.
    expect(fakes.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed turn with the friendly failure message", async () => {
    const { app } = makeApp({
      existingSession: fakeSession({
        id: CALLER_SESSION,
        status: "failed",
        result_summary: undefined,
        error: "ENOENT: claude not found",
      }),
    });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SESSION });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ replayed: true, status: "failed" });
    expect(res.body.response).toBe("ENOENT: claude not found");
  });

  it("409s a retry that lands while the original is still running", async () => {
    const { app, fakes } = makeApp({
      existingSession: fakeSession({ id: CALLER_SESSION, status: "running" }),
    });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SESSION });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "session_in_flight" });
    expect(fakes.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s a session id owned by a different agent", async () => {
    const { app, fakes } = makeApp({
      existingSession: fakeSession({ id: CALLER_SESSION, agent_id: "agent_someone_else" }),
    });

    const res = await request(app)
      .post("/chat")
      .send({ message: "hi", session_id: CALLER_SESSION });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "session_belongs_to_other_caller" });
    expect(fakes.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("runs the turn when the id is unknown, non-chat, or still pending", async () => {
    const cases: Array<Session | undefined> = [
      undefined,
      fakeSession({ id: CALLER_SESSION, type: "task" }),
      fakeSession({ id: CALLER_SESSION, status: "pending" }),
    ];

    for (const existingSession of cases) {
      const { app, fakes } = makeApp({ existingSession });
      const res = await request(app)
        .post("/chat")
        .send({ message: "hi", session_id: CALLER_SESSION });
      expect(res.status).toBe(200);
      expect(res.body.replayed).toBeUndefined();
      expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledOnce();
    }
  });

  it("passes a well-formed caller session id through as the dispatch override", async () => {
    const { app, fakes } = makeApp();

    await request(app).post("/chat").send({ message: "hi", session_id: CALLER_SESSION });
    expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: CALLER_SESSION }),
    );
  });

  it.each([
    ["wrong prefix", "chat_cccccccccccc"],
    ["too short", "sess_abc"],
    ["illegal characters", "sess_aaaa-aaa-aaa"],
    ["not a string", 12345],
  ])("ignores a malformed session_id (%s) rather than trusting it", async (_label, session_id) => {
    const { app, fakes } = makeApp();

    const res = await request(app).post("/chat").send({ message: "hi", session_id });
    expect(res.status).toBe(200);
    // Never looked up, and never handed to dispatch as an override.
    expect(fakes.sessionRepo.findById).not.toHaveBeenCalled();
    expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: undefined }),
    );
  });
});

describe("POST /chat — rate limiting", () => {
  it("429s a second concurrent turn for the same person", async () => {
    // maxConcurrent 1 and a resolver we hold open, so the first turn is
    // still in flight when the second arrives.
    let release!: (s: Session) => void;
    const { app } = makeApp({
      rateLimiter: new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 10 }),
      resolve: () => new Promise<Session>((r) => (release = r)),
    });

    // `.then()` is what actually sends a supertest request — without it
    // the first turn would never reach the resolver.
    const first = request(app)
      .post("/chat")
      .send({ message: "one" })
      .then((r) => r);
    await vi.waitFor(() => expect(release).toBeDefined());

    const second = await request(app).post("/chat").send({ message: "two" });
    expect(second.status).toBe(429);
    expect(second.body).toMatchObject({ error: "turn_in_flight" });
    expect(second.headers["retry-after"]).toBeDefined();

    release(fakeSession({ status: "succeeded", result_summary: "done" }));
    await first;
  });

  it("429s past the sliding-window ceiling with a Retry-After", async () => {
    const { app } = makeApp({
      rateLimiter: new ChatRateLimiter({
        maxConcurrent: 5,
        maxPerWindow: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    });

    const ok = await request(app).post("/chat").send({ message: "one" });
    expect(ok.status).toBe(200);

    const limited = await request(app).post("/chat").send({ message: "two" });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: "rate_limited" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("releases the slot after a successful turn", async () => {
    const { app } = makeApp({
      rateLimiter: new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 10 }),
    });

    for (const message of ["one", "two", "three"]) {
      const res = await request(app).post("/chat").send({ message });
      expect(res.status).toBe(200);
    }
  });

  it("releases the slot when dispatch throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({
      rateLimiter: new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 10 }),
      dispatch: async () => {
        throw new Error("no runtime");
      },
    });

    const first = await request(app).post("/chat").send({ message: "one" });
    expect(first.status).toBe(500);

    // Still 500 (not 429) — the failed turn didn't leak its slot.
    const second = await request(app).post("/chat").send({ message: "two" });
    expect(second.status).toBe(500);
  });

  it("releases the slot when the daemon is offline", async () => {
    const { app } = makeApp({
      rateLimiter: new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 10 }),
      dispatch: async () => ({
        session: fakeSession({ status: "pending" }),
        runtime_id: "rt_1",
      }),
      online: false,
    });

    const first = await request(app).post("/chat").send({ message: "one" });
    expect(first.status).toBe(503);

    const second = await request(app).post("/chat").send({ message: "two" });
    expect(second.status).toBe(503);
  });
});

describe("POST /chat — dispatch and daemon state", () => {
  it("dispatches a fresh chat turn when no prior session is given", async () => {
    const { app, fakes } = makeApp();

    await request(app).post("/chat").send({ message: "hello" });
    expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      intent: "hello",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
  });

  it("carries prior_session_id through as a chat_continuation", async () => {
    const { app, fakes } = makeApp();

    await request(app)
      .post("/chat")
      .send({ message: "and then?", prior_session_id: "sess_aaaaaaaaaaaa" });
    expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_aaaaaaaaaaaa" },
      }),
    );
  });

  it("ignores a non-string prior_session_id", async () => {
    const { app, fakes } = makeApp();

    await request(app).post("/chat").send({ message: "hi", prior_session_id: 99 });
    expect(fakes.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ reason: { kind: "fresh" } }),
    );
  });

  it("503s rather than hanging 90s when the bound daemon is offline", async () => {
    const { app, fakes } = makeApp({
      dispatch: async () => ({
        session: fakeSession({ status: "pending" }),
        runtime_id: "rt_1",
      }),
      online: false,
    });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: "agent_offline" });
    expect(fakes.hub.isOnline).toHaveBeenCalledWith("rt_1");
    // Never waited on a resolver nobody was going to fire.
    expect(fakes.chatResolver.register).not.toHaveBeenCalled();
  });

  it("waits on the resolver for a null-runtime agent even with no daemon online", async () => {
    const { app, fakes } = makeApp({
      dispatch: async () => ({ session: fakeSession({ status: "pending" }), runtime_id: null }),
      online: false,
    });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    // Null runtime means the in-process executor claims it — no hub probe.
    expect(fakes.hub.isOnline).not.toHaveBeenCalled();
    expect(fakes.chatResolver.register).toHaveBeenCalledWith("sess_aaaaaaaaaaaa", 90_000);
  });

  it("500s a dispatch failure behind a request id", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({
      dispatch: async () => {
        throw new Error("agent not found: agent_a");
      },
    });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    expect(JSON.stringify(res.body)).not.toContain("agent not found");
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("POST /chat — turn response", () => {
  it("returns the visible text with directives split out", async () => {
    const { app } = makeApp({
      resolve: async () =>
        fakeSession({
          status: "succeeded",
          result_summary:
            'All set.<open_view path="/tasks" label="Tasks" />' +
            '<suggest_action label="Show me" prompt="show the tasks" />',
        }),
    });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT, name: "Ada's team", hierarchy: "team" },
      status: "succeeded",
      response: "All set.",
      open_view: { path: "/tasks", label: "Tasks" },
      suggested_actions: [{ label: "Show me", prompt: "show the tasks" }],
    });
    expect(res.body.replayed).toBeUndefined();
  });

  it("omits the optional directive keys when the reply carries none", async () => {
    const { app } = makeApp({
      resolve: async () => fakeSession({ status: "succeeded", result_summary: "plain answer" }),
    });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.body.response).toBe("plain answer");
    expect(res.body.view_refs).toEqual([]);
    expect(res.body.open_view).toBeUndefined();
    expect(res.body.suggested_actions).toBeUndefined();
    expect(res.body.repo_cards).toBeUndefined();
  });

  it("rewrites a bare CLI exit on a failed turn into the daemon-log pointer", async () => {
    const { app } = makeApp({
      resolve: async () =>
        fakeSession({
          status: "failed",
          result_summary: undefined,
          error: "CLI exited with code 1",
        }),
    });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.response).toContain("beevibe-daemon start");
  });

  it("rewrites the daemon's runtime-missing throw into something actionable", async () => {
    // Produced with the shared helper so a change to the wire string
    // fails here rather than silently degrading to the raw throw.
    const { app } = makeApp({
      resolve: async () =>
        fakeSession({
          status: "failed",
          result_summary: undefined,
          error: runtimeMissingError("codex"),
        }),
    });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.response).toContain("pinned to the codex runtime");
    expect(res.body.response).toContain("beevibe-daemon sync");
    expect(res.body.response).not.toContain("No runtime registered");
  });

  it("504s a turn that outlives the 90s ceiling", async () => {
    const { app } = makeApp({
      resolve: async () => {
        throw new Error("chat resolver timeout (90000ms) for sess_aaaaaaaaaaaa");
      },
    });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      error: "chat_turn_timeout",
      timeout_ms: 90_000,
    });
    expect(res.body.message).toContain("90s");
  });

  it("500s a non-timeout resolver failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = makeApp({
      resolve: async () => {
        throw new Error("chat resolver already registered for sess_aaaaaaaaaaaa");
      },
    });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });
});

describe("POST /chat — onboarding flip", () => {
  it("completes onboarding on the first successful turn", async () => {
    const { app, fakes } = makeApp({
      person: fakePerson({ onboarding_completed_at: undefined }),
    });

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(fakes.personRepo.update).toHaveBeenCalledWith(PERSON, {
      onboarding_completed_at: expect.any(Date),
    });
  });

  it("leaves an already-onboarded person alone", async () => {
    const { app, fakes } = makeApp({
      person: fakePerson({ onboarding_completed_at: new Date("2026-03-01") }),
    });

    await request(app).post("/chat").send({ message: "hi" });
    expect(fakes.personRepo.update).not.toHaveBeenCalled();
  });

  it("does not complete onboarding on a failed first turn", async () => {
    const { app, fakes } = makeApp({
      person: fakePerson({ onboarding_completed_at: undefined }),
      resolve: async () => fakeSession({ status: "failed", error: "it broke" }),
    });

    await request(app).post("/chat").send({ message: "hi" });
    expect(fakes.personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers the turn when the onboarding write fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, fakes } = makeApp({
      person: fakePerson({ onboarding_completed_at: undefined }),
    });
    (fakes.personRepo.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("person table locked"),
    );

    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Fire-and-forget: the rejection is logged on a later tick.
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalled());
  });

  it("treats a missing person row as not-yet-onboarded", async () => {
    const { app, fakes } = makeApp({ person: null });

    await request(app).post("/chat").send({ message: "hi" });
    expect(fakes.personRepo.update).toHaveBeenCalled();
  });
});
