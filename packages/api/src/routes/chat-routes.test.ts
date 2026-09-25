/**
 * The four `/chat` handlers — unit tests with vitest fakes (no DB).
 *
 * `chat-internals.test.ts` already covers the pure helpers
 * (`groupIntoConversations`, `chainToMessages`, `failureMessageFor`);
 * this file covers the wiring around them: the conversation list and
 * history projections, the soft-delete guard, and the POST turn's
 * gauntlet of idempotent replay → rate limit → dispatch → resolver,
 * each of which has its own status code the web client branches on.
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

const PERSON = "person_1";
const AGENT_ID = "agent_a";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT_ID,
    name: "Ada's team",
    owner_id: PERSON,
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Agent;
}

function fakePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: PERSON,
    name: "Ada",
    email: "ada@example.com",
    created_at: new Date("2026-04-01"),
    updated_at: new Date("2026-04-01"),
    ...overrides,
  } as Person;
}

function chat(overrides: Partial<Session> & Pick<Session, "id">): Session {
  return {
    agent_id: AGENT_ID,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-04-01T10:00:00Z"),
    ...overrides,
  } as Session;
}

function stubAuth(source: "human" | "agent" = "human") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.caller =
      source === "human"
        ? { source: "human", agentId: AGENT_ID, hierarchyLevel: "team", personId: PERSON }
        : { source: "agent", agentId: AGENT_ID, hierarchyLevel: "ic" };
    next();
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
}

interface AppOpts {
  source?: "human" | "agent";
  agent?: Agent | undefined;
  person?: Person | undefined;
  chats?: Session[];
  /** `/chat` mismatch probe; undefined means "runtime row missing". */
  runtime?: Runtime | undefined;
  rateLimiter?: ChatRateLimiter;
  online?: boolean;
}

function makeApp(opts: AppOpts = {}) {
  const fakes: Fakes = {
    agentRepo: {
      findTopLevelForOwner: vi.fn(async () =>
        "agent" in opts ? opts.agent : fakeAgent(),
      ),
    } as unknown as AgentRepository,
    personRepo: {
      findById: vi.fn(async () => ("person" in opts ? opts.person : fakePerson())),
      update: vi.fn(async () => fakePerson()),
    } as unknown as PersonRepository,
    runtimeRepo: {
      findById: vi.fn(async () => opts.runtime),
    } as unknown as RuntimeRepository,
    sessionRepo: {
      listChatForAgent: vi.fn(async () => opts.chats ?? []),
      softDeleteChatChain: vi.fn(async () => 2),
      findById: vi.fn(async () => undefined),
    } as unknown as SessionRepository,
    dispatchService: {
      dispatchTask: vi.fn(async () => ({
        session: chat({ id: "sess_dispatched1", status: "pending" }),
        runtime_id: null,
      })),
    } as unknown as DispatchService,
    chatResolver: {
      register: vi.fn(async () =>
        chat({ id: "sess_dispatched1", result_summary: "done" }),
      ),
    } as unknown as ChatResolver,
    hub: {
      isOnline: vi.fn(() => opts.online ?? true),
    } as unknown as DaemonHub,
  };

  const app = express();
  app.use(json());
  app.use(
    "/chat",
    createChatRouter({
      authMiddleware: stubAuth(opts.source ?? "human"),
      ...fakes,
      ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
    }),
  );
  return { app, ...fakes };
}

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /chat/conversations", () => {
  it("rejects an agent token", async () => {
    const { app } = makeApp({ source: "agent" });
    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const { app, sessionRepo } = makeApp({ agent: undefined });
    const res = await request(app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain with its head title, turn count and tail preview", async () => {
    const { app } = makeApp({
      chats: [
        chat({ id: "sess_head00000001", intent: "how do I deploy?" }),
        chat({
          id: "sess_tail00000001",
          prior_session_id: "sess_head00000001",
          intent: "and the rollback?",
          result_summary: "Run  `beevibe   rollback`.",
          created_at: new Date("2026-04-01T10:05:00Z"),
        }),
      ],
    });

    const res = await request(app).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head00000001",
        title: "how do I deploy?",
        turn_count: 2,
        last_at: "2026-04-01T10:05:00.000Z",
        last_preview: "Run `beevibe rollback`.",
      },
    ]);
  });

  it("previews the error, then the intent, when there is no result_summary", async () => {
    const { app } = makeApp({
      chats: [
        chat({ id: "sess_a00000000001", status: "failed", error: "CLI blew up" }),
        chat({ id: "sess_b00000000002", status: "running", intent: "in flight" }),
      ],
    });

    const res = await request(app).get("/chat/conversations");
    const previews = (res.body.conversations as Array<{ last_preview: string }>).map(
      (c) => c.last_preview,
    );
    expect(previews).toEqual(expect.arrayContaining(["CLI blew up", "in flight"]));
  });

  it("ellipsizes a preview longer than 140 chars", async () => {
    const { app } = makeApp({
      chats: [chat({ id: "sess_a00000000001", result_summary: "x".repeat(300) })],
    });
    const res = await request(app).get("/chat/conversations");
    const preview = res.body.conversations[0].last_preview as string;
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("caps the list at 50 conversations", async () => {
    const chats = Array.from({ length: 60 }, (_, i) =>
      chat({
        id: `sess_${String(i).padStart(12, "0")}`,
        created_at: new Date(Date.UTC(2026, 3, 1, 10, i)),
      }),
    );
    const { app, sessionRepo } = makeApp({ chats });
    const res = await request(app).get("/chat/conversations");
    expect(res.body.conversations).toHaveLength(50);
    // The DB fetch is bounded too, independent of the page size.
    expect(sessionRepo.listChatForAgent).toHaveBeenCalledWith(AGENT_ID, 400);
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /chat/conversations/:headId", () => {
  it("soft-deletes the chain scoped to the caller's agent", async () => {
    const { app, sessionRepo } = makeApp();
    const res = await request(app).delete("/chat/conversations/sess_head00000001");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 2 });
    expect(sessionRepo.softDeleteChatChain).toHaveBeenCalledWith(
      "sess_head00000001",
      AGENT_ID,
    );
  });

  it("is idempotent — a chain already deleted reports zero rows, not an error", async () => {
    const { app, sessionRepo } = makeApp();
    vi.mocked(sessionRepo.softDeleteChatChain).mockResolvedValue(0);
    const res = await request(app).delete("/chat/conversations/sess_head00000001");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("404s when the caller has no primary agent, without deleting anything", async () => {
    const { app, sessionRepo } = makeApp({ agent: undefined });
    const res = await request(app).delete("/chat/conversations/sess_head00000001");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
    expect(sessionRepo.softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("rejects an agent token", async () => {
    const { app } = makeApp({ source: "agent" });
    const res = await request(app).delete("/chat/conversations/sess_head00000001");
    expect(res.status).toBe(403);
  });

  it("returns a 500 with a request id when the repo throws", async () => {
    const { app, sessionRepo } = makeApp();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(sessionRepo.softDeleteChatChain).mockRejectedValue(new Error("deadlock"));

    const res = await request(app).delete("/chat/conversations/sess_head00000001");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // The internal detail stays in the log, not the body.
    expect(JSON.stringify(res.body)).not.toContain("deadlock");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /chat", () => {
  it("returns a null agent and empty history when none is provisioned", async () => {
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

  it("returns the agent with an empty history when there are no chats yet", async () => {
    const { app } = makeApp({ chats: [] });
    const res = await request(app).get("/chat");
    expect(res.body.agent).toEqual({ id: AGENT_ID, name: "Ada's team", hierarchy: "team" });
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
  });

  it("defaults to the most recent conversation and reports its tail", async () => {
    const { app } = makeApp({
      chats: [
        chat({
          id: "sess_new000000001",
          intent: "newest thread",
          result_summary: "sure",
          created_at: new Date("2026-04-02T10:00:00Z"),
        }),
        chat({
          id: "sess_old000000001",
          intent: "older thread",
          created_at: new Date("2026-04-01T10:00:00Z"),
        }),
      ],
    });

    const res = await request(app).get("/chat");

    expect(res.body.conversation_id).toBe("sess_new000000001");
    expect(res.body.prior_session_id).toBe("sess_new000000001");
    expect(res.body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "agent"]);
    expect(res.body.messages[0].content).toBe("newest thread");
  });

  it("selects the conversation named by ?c=", async () => {
    const { app } = makeApp({
      chats: [
        chat({
          id: "sess_new000000001",
          intent: "newest thread",
          created_at: new Date("2026-04-02T10:00:00Z"),
        }),
        chat({
          id: "sess_old000000001",
          intent: "older thread",
          created_at: new Date("2026-04-01T10:00:00Z"),
        }),
      ],
    });

    const res = await request(app).get("/chat").query({ c: "sess_old000000001" });

    expect(res.body.conversation_id).toBe("sess_old000000001");
    expect(res.body.messages[0].content).toBe("older thread");
  });

  it("renders the empty state, not a 404, for an unknown ?c=", async () => {
    const { app } = makeApp({ chats: [chat({ id: "sess_a00000000001" })] });
    const res = await request(app).get("/chat").query({ c: "sess_nonexistent" });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
    expect(res.body.agent).not.toBeNull();
  });

  it("keeps only the last 25 turns of a long chain", async () => {
    const chats: Session[] = [];
    for (let i = 0; i < 40; i++) {
      chats.push(
        chat({
          id: `sess_${String(i).padStart(12, "0")}`,
          ...(i > 0 ? { prior_session_id: `sess_${String(i - 1).padStart(12, "0")}` } : {}),
          intent: `turn ${i}`,
          result_summary: `reply ${i}`,
          created_at: new Date(Date.UTC(2026, 3, 1, 10, i)),
        }),
      );
    }
    const { app } = makeApp({ chats });

    const res = await request(app).get("/chat");

    // 25 sessions × (user + agent).
    expect(res.body.messages).toHaveLength(50);
    expect(res.body.messages[0].content).toBe("turn 15");
    expect(res.body.prior_session_id).toBe("sess_000000000039");
  });

  it("renders a failed turn in history with the friendly failure message", async () => {
    const { app } = makeApp({
      chats: [
        chat({
          id: "sess_fail00000001",
          intent: "deploy",
          status: "failed",
          error: "disk full",
        }),
      ],
    });

    const res = await request(app).get("/chat");

    expect(res.body.messages).toMatchObject([
      { id: "u_sess_fail00000001", role: "user", content: "deploy" },
      {
        id: "a_sess_fail00000001",
        role: "agent",
        content: "disk full",
        session_id: "sess_fail00000001",
      },
    ]);
  });

  it("renders a watch_tasks wake turn as a system message carrying the summary", async () => {
    const { app } = makeApp({
      chats: [
        chat({
          id: "sess_wake00000001",
          intent:
            "<system-wake>Task #abc123 finished: deploy succeeded.\n\nDecide next steps.</system-wake>",
          result_summary: "Rolling forward.",
        }),
      ],
    });

    const res = await request(app).get("/chat");

    // The wrapper tags and the agent-facing "Decide next steps." prompt are
    // stripped; the human sees why the agent woke up.
    expect(res.body.messages).toMatchObject([
      {
        id: "w_sess_wake00000001",
        role: "system",
        content: "Task #abc123 finished: deploy succeeded.",
        session_id: "sess_wake00000001",
      },
      { id: "a_sess_wake00000001", role: "agent", content: "Rolling forward." },
    ]);
  });

  it("surfaces in_flight_session_id while the tail turn is still running", async () => {
    const { app } = makeApp({
      chats: [chat({ id: "sess_a00000000001", status: "running" })],
    });
    const res = await request(app).get("/chat");
    expect(res.body.in_flight_session_id).toBe("sess_a00000000001");
  });

  it("omits in_flight_session_id once the tail turn is terminal", async () => {
    const { app } = makeApp({ chats: [chat({ id: "sess_a00000000001" })] });
    const res = await request(app).get("/chat");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("flags a chain pinned to a CLI the agent no longer uses", async () => {
    const { app, runtimeRepo } = makeApp({
      chats: [chat({ id: "sess_a00000000001", runtime_id: "rt_1" })],
      runtime: { id: "rt_1", cli: "codex" } as unknown as Runtime,
    });

    const res = await request(app).get("/chat");

    expect(runtimeRepo.findById).toHaveBeenCalledWith("rt_1");
    expect(res.body.runtime_mismatch).toEqual({ pinned_cli: "codex", current_cli: "claude" });
  });

  it("does not flag a chain pinned to the agent's current CLI", async () => {
    const { app } = makeApp({
      chats: [chat({ id: "sess_a00000000001", runtime_id: "rt_1" })],
      runtime: { id: "rt_1", cli: "claude" } as unknown as Runtime,
    });
    const res = await request(app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("does not probe for a mismatch when the tail has no runtime, and tolerates a missing or unknown runtime row", async () => {
    const noRuntime = makeApp({ chats: [chat({ id: "sess_a00000000001" })] });
    const noRuntimeRes = await request(noRuntime.app).get("/chat");
    expect(noRuntime.runtimeRepo.findById).not.toHaveBeenCalled();
    expect(noRuntimeRes.body.runtime_mismatch).toBeUndefined();

    const missingRow = makeApp({
      chats: [chat({ id: "sess_a00000000001", runtime_id: "rt_gone" })],
      runtime: undefined,
    });
    expect((await request(missingRow.app).get("/chat")).body.runtime_mismatch).toBeUndefined();

    const unknownCli = makeApp({
      chats: [chat({ id: "sess_a00000000001", runtime_id: "rt_1" })],
      runtime: { id: "rt_1", cli: "emacs" } as unknown as Runtime,
    });
    expect((await request(unknownCli.app).get("/chat")).body.runtime_mismatch).toBeUndefined();
  });

  it("rejects an agent token", async () => {
    const { app } = makeApp({ source: "agent" });
    expect((await request(app).get("/chat")).status).toBe(403);
  });
});

// ── POST /chat ───────────────────────────────────────────────────────────

describe("POST /chat — validation", () => {
  it("rejects an agent token", async () => {
    const { app } = makeApp({ source: "agent" });
    expect((await request(app).post("/chat").send({ message: "hi" })).status).toBe(403);
  });

  it("400s on a missing, blank or non-string message", async () => {
    const { app, dispatchService } = makeApp();
    for (const body of [{}, { message: "   " }, { message: 7 }]) {
      const res = await request(app).post("/chat").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("message_required");
    }
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const { app, dispatchService } = makeApp({ agent: undefined });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });
});

describe("POST /chat — dispatch", () => {
  it("trims the message and dispatches a fresh chat session", async () => {
    const { app, dispatchService } = makeApp();
    const res = await request(app).post("/chat").send({ message: "  deploy please  " });

    expect(res.status).toBe(200);
    expect(vi.mocked(dispatchService.dispatchTask).mock.calls[0]?.[0]).toEqual({
      agentId: AGENT_ID,
      intent: "deploy please",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
  });

  it("dispatches a continuation when prior_session_id is given", async () => {
    const { app, dispatchService } = makeApp();
    await request(app)
      .post("/chat")
      .send({ message: "and the rollback?", prior_session_id: "sess_prior0000001" });

    expect(vi.mocked(dispatchService.dispatchTask).mock.calls[0]?.[0]).toMatchObject({
      reason: { kind: "chat_continuation", prior_session_id: "sess_prior0000001" },
    });
  });

  it("honors a well-formed client session_id and ignores a malformed one", async () => {
    const good = makeApp();
    await request(good.app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abcABC123456" });
    expect(
      vi.mocked(good.dispatchService.dispatchTask).mock.calls[0]?.[0],
    ).toMatchObject({ sessionIdOverride: "sess_abcABC123456" });

    const bad = makeApp();
    await request(bad.app).post("/chat").send({ message: "hi", session_id: "nope" });
    expect(vi.mocked(bad.dispatchService.dispatchTask).mock.calls[0]?.[0]).toMatchObject({
      sessionIdOverride: undefined,
    });
  });

  it("returns the resolved turn with the agent header and parsed directives", async () => {
    const { app, chatResolver } = makeApp();
    vi.mocked(chatResolver.register).mockResolvedValue(
      chat({
        id: "sess_dispatched1",
        result_summary:
          'Deployed. <open_view path="/tasks" label="See tasks" />' +
          '<suggest_action label="Roll back" prompt="roll back" />',
      }),
    );

    const res = await request(app).post("/chat").send({ message: "deploy" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT_ID, name: "Ada's team", hierarchy: "team" },
      session_id: "sess_dispatched1",
      response: "Deployed.",
      status: "succeeded",
      open_view: { path: "/tasks", label: "See tasks" },
      suggested_actions: [{ label: "Roll back", prompt: "roll back" }],
    });
    expect(res.body.replayed).toBeUndefined();
  });

  it("renders a failed turn with the friendly failure message", async () => {
    const { app, chatResolver } = makeApp();
    vi.mocked(chatResolver.register).mockResolvedValue(
      chat({ id: "sess_dispatched1", status: "failed", error: "disk full" }),
    );

    const res = await request(app).post("/chat").send({ message: "deploy" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    expect(res.body.response).toBe("disk full");
  });

  it("503s when the session is pinned to an offline daemon", async () => {
    const { app, dispatchService, chatResolver } = makeApp({ online: false });
    vi.mocked(dispatchService.dispatchTask).mockResolvedValue({
      session: chat({ id: "sess_dispatched1", status: "pending" }),
      runtime_id: "rt_1",
    });

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(chatResolver.register).not.toHaveBeenCalled();
  });

  it("proceeds for a null-runtime session even with no daemon online", async () => {
    const { app, hub } = makeApp({ online: false });
    const res = await request(app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(hub.isOnline).not.toHaveBeenCalled();
  });

  it("500s when dispatch throws", async () => {
    const { app, dispatchService } = makeApp();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(dispatchService.dispatchTask).mockRejectedValue(new Error("pool gone"));

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    err.mockRestore();
  });

  it("504s when the resolver times out", async () => {
    const { app, chatResolver } = makeApp();
    vi.mocked(chatResolver.register).mockRejectedValue(
      new Error("chat turn timeout after 90000ms"),
    );

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ error: "chat_turn_timeout", timeout_ms: 90_000 });
  });

  it("500s when the resolver rejects for any other reason", async () => {
    const { app, chatResolver } = makeApp();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(chatResolver.register).mockRejectedValue(new Error("daemon crashed"));

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    err.mockRestore();
  });
});

describe("POST /chat — onboarding flip", () => {
  it("stamps onboarding_completed_at after the first successful turn", async () => {
    const { app, personRepo } = makeApp({ person: fakePerson() });
    await request(app).post("/chat").send({ message: "hi" });

    expect(personRepo.update).toHaveBeenCalledTimes(1);
    expect(vi.mocked(personRepo.update).mock.calls[0]?.[0]).toBe(PERSON);
    expect(
      (vi.mocked(personRepo.update).mock.calls[0]?.[1] as { onboarding_completed_at: Date })
        .onboarding_completed_at,
    ).toBeInstanceOf(Date);
  });

  it("does not re-stamp an already-onboarded person", async () => {
    const { app, personRepo } = makeApp({
      person: fakePerson({ onboarding_completed_at: new Date("2026-04-01") }),
    });
    await request(app).post("/chat").send({ message: "hi" });
    expect(personRepo.update).not.toHaveBeenCalled();
  });

  it("does not stamp when the turn failed", async () => {
    const { app, personRepo, chatResolver } = makeApp({ person: fakePerson() });
    vi.mocked(chatResolver.register).mockResolvedValue(
      chat({ id: "sess_dispatched1", status: "failed", error: "nope" }),
    );
    await request(app).post("/chat").send({ message: "hi" });
    expect(personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers the turn when the flip write fails", async () => {
    const { app, personRepo } = makeApp({ person: fakePerson() });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(personRepo.update).mockRejectedValue(new Error("write conflict"));

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    err.mockRestore();
  });
});

describe("POST /chat — idempotent replay", () => {
  const SID = "sess_abcABC123456";

  it("replays a finished turn instead of spawning another", async () => {
    const { app, sessionRepo, dispatchService } = makeApp();
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      chat({ id: SID, status: "succeeded", result_summary: "already answered" }),
    );

    const res = await request(app).post("/chat").send({ message: "hi", session_id: SID });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      session_id: SID,
      response: "already answered",
      status: "succeeded",
      replayed: true,
    });
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed turn with its failure message", async () => {
    const { app, sessionRepo } = makeApp();
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      chat({ id: SID, status: "failed", error: "disk full" }),
    );

    const res = await request(app).post("/chat").send({ message: "hi", session_id: SID });

    expect(res.body).toMatchObject({ status: "failed", response: "disk full", replayed: true });
  });

  it("409s while the session is still running", async () => {
    const { app, sessionRepo, dispatchService } = makeApp();
    vi.mocked(sessionRepo.findById).mockResolvedValue(chat({ id: SID, status: "running" }));

    const res = await request(app).post("/chat").send({ message: "hi", session_id: SID });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the session id collides with another caller's session", async () => {
    const { app, sessionRepo, dispatchService } = makeApp();
    vi.mocked(sessionRepo.findById).mockResolvedValue(
      chat({ id: SID, agent_id: "agent_someone_else" }),
    );

    const res = await request(app).post("/chat").send({ message: "hi", session_id: SID });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
    expect(dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("falls through to a live turn for a pending row, or a non-chat/absent one", async () => {
    const pending = makeApp();
    vi.mocked(pending.sessionRepo.findById).mockResolvedValue(
      chat({ id: SID, status: "pending" }),
    );
    expect(
      (await request(pending.app).post("/chat").send({ message: "hi", session_id: SID })).status,
    ).toBe(200);
    expect(pending.dispatchService.dispatchTask).toHaveBeenCalled();

    const otherType = makeApp();
    vi.mocked(otherType.sessionRepo.findById).mockResolvedValue(
      chat({ id: SID, type: "task" }),
    );
    await request(otherType.app).post("/chat").send({ message: "hi", session_id: SID });
    expect(otherType.dispatchService.dispatchTask).toHaveBeenCalled();

    const absent = makeApp();
    await request(absent.app).post("/chat").send({ message: "hi", session_id: SID });
    expect(absent.dispatchService.dispatchTask).toHaveBeenCalled();
  });

  it("does not look for a replay when no session_id was sent", async () => {
    const { app, sessionRepo } = makeApp();
    await request(app).post("/chat").send({ message: "hi" });
    expect(sessionRepo.findById).not.toHaveBeenCalled();
  });
});

describe("POST /chat — rate limiting", () => {
  it("429s with Retry-After when a turn is already in flight for the person", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const { app, dispatchService, chatResolver } = makeApp({ rateLimiter: limiter });
    // Hold the only concurrent slot for the whole request.
    let release: () => void = () => {};
    vi.mocked(chatResolver.register).mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve(chat({ id: "sess_dispatched1" }));
      }),
    );

    // `.then` is what actually fires a supertest request.
    const first = request(app)
      .post("/chat")
      .send({ message: "one" })
      .then((r) => r);
    // Wait until the first request holds the slot before sending the second.
    await vi.waitFor(() => expect(chatResolver.register).toHaveBeenCalled());
    const second = await request(app).post("/chat").send({ message: "two" });

    expect(second.status).toBe(429);
    expect(second.body.error).toBe("turn_in_flight");
    expect(second.headers["retry-after"]).toBeDefined();
    expect(second.body.retry_after_ms).toBeTypeOf("number");
    // Only the first turn reached dispatch.
    expect(dispatchService.dispatchTask).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it("429s as rate_limited once the sliding window is full", async () => {
    const limiter = new ChatRateLimiter({
      maxConcurrent: 5,
      maxPerWindow: 2,
      windowMs: 60_000,
      now: () => 1_000,
    });
    const { app } = makeApp({ rateLimiter: limiter });

    expect((await request(app).post("/chat").send({ message: "one" })).status).toBe(200);
    expect((await request(app).post("/chat").send({ message: "two" })).status).toBe(200);
    const third = await request(app).post("/chat").send({ message: "three" });

    expect(third.status).toBe(429);
    expect(third.body.error).toBe("rate_limited");
  });

  it("releases the slot when dispatch fails, so the next turn is not blocked", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const { app, dispatchService } = makeApp({ rateLimiter: limiter });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(dispatchService.dispatchTask).mockRejectedValueOnce(new Error("pool gone"));

    expect((await request(app).post("/chat").send({ message: "one" })).status).toBe(500);
    expect((await request(app).post("/chat").send({ message: "two" })).status).toBe(200);
    err.mockRestore();
  });

  it("releases the slot when the daemon is offline", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const { app, dispatchService } = makeApp({ rateLimiter: limiter, online: false });
    vi.mocked(dispatchService.dispatchTask).mockResolvedValueOnce({
      session: chat({ id: "sess_dispatched1", status: "pending" }),
      runtime_id: "rt_1",
    });

    expect((await request(app).post("/chat").send({ message: "one" })).status).toBe(503);
    expect((await request(app).post("/chat").send({ message: "two" })).status).toBe(200);
  });

  it("releases the slot after a resolver timeout", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000 });
    const { app, chatResolver } = makeApp({ rateLimiter: limiter });
    vi.mocked(chatResolver.register).mockRejectedValueOnce(new Error("timeout"));

    expect((await request(app).post("/chat").send({ message: "one" })).status).toBe(504);
    expect((await request(app).post("/chat").send({ message: "two" })).status).toBe(200);
  });
});
