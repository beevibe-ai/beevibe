/**
 * `createChatRouter` handler tests — unit tests with vitest fakes (no DB).
 *
 * `chat-internals.test.ts` already covers the three exported pure
 * helpers (`groupIntoConversations`, `failureMessageFor`,
 * `chainToMessages`). What was untested is every *handler*: the four
 * routes and the private helpers only reachable through them
 * (`previewOf`, `detectRuntimeMismatch`, `toChatTurnResponse`,
 * `tryReplay`, `handleError`).
 *
 * The branches worth pinning here are the ones that cost money or
 * leak history:
 *   - idempotent replay (`tryReplay`) — a double-submit must not spawn
 *     a second CLI subprocess, and a session id collision must 403
 *     rather than hand back someone else's transcript;
 *   - the rate limiter's `release()` on every early return, or one
 *     failed dispatch wedges the caller's concurrent slot forever;
 *   - 503 on an offline daemon vs. the 90s timeout, and 504 when the
 *     resolver does time out;
 *   - `runtime_mismatch` on GET, which is the only signal the user
 *     gets that their new CLI isn't being used.
 */
import express, { json } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { createChatRouter, type ChatRoutesDeps } from "./chat.js";

const PERSON = "person_1";
const AGENT = "agent_1";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: AGENT,
    name: "Ada",
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    ...overrides,
  } as unknown as Agent;
}

function fakeSession(overrides: Partial<Session> & Pick<Session, "id">): Session {
  return {
    agent_id: AGENT,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as unknown as Session;
}

function fakePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: PERSON,
    email: "ada@example.com",
    onboarding_completed_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as unknown as Person;
}

interface Harness {
  app: express.Express;
  agentRepo: { findTopLevelForOwner: ReturnType<typeof vi.fn> };
  personRepo: { findById: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  runtimeRepo: { findById: ReturnType<typeof vi.fn> };
  sessionRepo: {
    findById: ReturnType<typeof vi.fn>;
    listChatForAgent: ReturnType<typeof vi.fn>;
    softDeleteChatChain: ReturnType<typeof vi.fn>;
  };
  dispatchService: { dispatchTask: ReturnType<typeof vi.fn> };
  chatResolver: { register: ReturnType<typeof vi.fn> };
  hub: { isOnline: ReturnType<typeof vi.fn> };
}

/**
 * Mount the router behind a stub auth middleware that stamps the
 * caller the real one would. `source` is a knob so the `requireHuman`
 * 403 path is reachable.
 */
function harness(
  opts: { source?: "human" | "agent"; rateLimiter?: ChatRateLimiter } = {},
): Harness {
  const agentRepo = { findTopLevelForOwner: vi.fn() };
  const personRepo = { findById: vi.fn().mockResolvedValue(fakePerson()), update: vi.fn() };
  const runtimeRepo = { findById: vi.fn() };
  const sessionRepo = {
    findById: vi.fn(),
    listChatForAgent: vi.fn().mockResolvedValue([]),
    softDeleteChatChain: vi.fn(),
  };
  const dispatchService = { dispatchTask: vi.fn() };
  const chatResolver = { register: vi.fn() };
  const hub = { isOnline: vi.fn().mockReturnValue(true) };

  const deps: ChatRoutesDeps = {
    authMiddleware: (req, _res, next) => {
      req.caller =
        (opts.source ?? "human") === "human"
          ? { source: "human", agentId: AGENT, hierarchyLevel: "team", personId: PERSON }
          : { source: "agent", agentId: AGENT, hierarchyLevel: "team" };
      next();
    },
    agentRepo: agentRepo as unknown as AgentRepository,
    personRepo: personRepo as unknown as PersonRepository,
    runtimeRepo: runtimeRepo as unknown as RuntimeRepository,
    sessionRepo: sessionRepo as unknown as SessionRepository,
    dispatchService: dispatchService as unknown as DispatchService,
    chatResolver: chatResolver as unknown as ChatResolver,
    hub: hub as unknown as DaemonHub,
    ...(opts.rateLimiter ? { rateLimiter: opts.rateLimiter } : {}),
  };

  const app = express();
  app.use(json());
  app.use("/chat", createChatRouter(deps));
  return {
    app,
    agentRepo,
    personRepo,
    runtimeRepo,
    sessionRepo,
    dispatchService,
    chatResolver,
    hub,
  };
}

describe("GET /chat/conversations", () => {
  it("403s a non-human caller", async () => {
    const h = harness({ source: "agent" });
    const res = await request(h.app).get("/chat/conversations");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("human_required");
  });

  it("returns an empty list when the caller has no primary agent", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);
    const res = await request(h.app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    expect(h.sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain with a turn count and the tail's preview", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({
        id: "sess_head",
        intent: "deploy the api",
        result_summary: "first reply",
        created_at: new Date("2026-01-01T10:00:00Z"),
      }),
      fakeSession({
        id: "sess_tail",
        prior_session_id: "sess_head",
        intent: "and the web",
        result_summary: "shipped it",
        created_at: new Date("2026-01-01T10:05:00Z"),
      }),
    ]);

    const res = await request(h.app).get("/chat/conversations");
    expect(res.status).toBe(200);
    expect(res.body.conversations).toHaveLength(1);
    expect(res.body.conversations[0]).toMatchObject({
      head_id: "sess_head",
      // Title comes from the *head* intent, preview from the tail.
      title: "deploy the api",
      turn_count: 2,
      last_at: "2026-01-01T10:05:00.000Z",
      last_preview: "shipped it",
    });
  });

  it("previews the error when a tail turn has no summary, and collapses whitespace", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", status: "failed", error: "boom\n  on   line 2" }),
    ]);
    const res = await request(h.app).get("/chat/conversations");
    expect(res.body.conversations[0]?.last_preview).toBe("boom on line 2");
  });

  it("truncates a preview longer than the 140-char budget with an ellipsis", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", result_summary: "x".repeat(300) }),
    ]);
    const res = await request(h.app).get("/chat/conversations");
    const preview: string = res.body.conversations[0].last_preview;
    expect(preview).toHaveLength(140);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("DELETE /chat/conversations/:headId", () => {
  it("404s when the caller has no primary agent", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);
    const res = await request(h.app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("agent_not_found");
  });

  it("soft-deletes the chain scoped to the caller's agent and reports the count", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.softDeleteChatChain.mockResolvedValue(3);
    const res = await request(h.app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    expect(h.sessionRepo.softDeleteChatChain).toHaveBeenCalledWith("sess_head", AGENT);
  });

  it("is idempotent — re-deleting an already-deleted chain still 200s with 0", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.softDeleteChatChain.mockResolvedValue(0);
    const res = await request(h.app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("maps a repo throw to a generic 500 carrying a request_id", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.softDeleteChatChain.mockRejectedValue(new Error("pg: deadlock detected"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(h.app).delete("/chat/conversations/sess_head");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // The internal detail stays server-side.
    expect(JSON.stringify(res.body)).not.toContain("deadlock");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("GET /chat", () => {
  it("returns a null agent envelope when none is provisioned", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);
    const res = await request(h.app).get("/chat");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: null,
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("rehydrates the most recent chain when no `c` is given", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({
        id: "sess_old",
        intent: "older",
        result_summary: "older reply",
        created_at: new Date("2026-01-01T09:00:00Z"),
      }),
      fakeSession({
        id: "sess_new",
        intent: "newer",
        result_summary: "newer reply",
        created_at: new Date("2026-01-01T11:00:00Z"),
      }),
    ]);

    const res = await request(h.app).get("/chat");
    expect(res.status).toBe(200);
    expect(res.body.conversation_id).toBe("sess_new");
    expect(res.body.prior_session_id).toBe("sess_new");
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "newer",
      "newer reply",
    ]);
    expect(res.body.agent).toEqual({ id: AGENT, name: "Ada", hierarchy: "team" });
  });

  it("honors `?c=` to select an older conversation", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({
        id: "sess_old",
        intent: "older",
        result_summary: "older reply",
        created_at: new Date("2026-01-01T09:00:00Z"),
      }),
      fakeSession({
        id: "sess_new",
        intent: "newer",
        result_summary: "newer reply",
        created_at: new Date("2026-01-01T11:00:00Z"),
      }),
    ]);

    const res = await request(h.app).get("/chat?c=sess_old");
    expect(res.body.conversation_id).toBe("sess_old");
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "older",
      "older reply",
    ]);
  });

  it("renders the empty state (not a 404) for a `c` that matches no chain", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([fakeSession({ id: "sess_a" })]);

    const res = await request(h.app).get("/chat?c=sess_does_not_exist");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      agent: { id: AGENT, name: "Ada", hierarchy: "team" },
      messages: [],
      prior_session_id: null,
      conversation_id: null,
    });
  });

  it("renders a failed turn as an agent bubble carrying the failure message", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({
        id: "sess_a",
        intent: "do the thing",
        status: "failed",
        error: "disk full",
        result_summary: undefined,
      }),
    ]);

    const res = await request(h.app).get("/chat");
    expect(res.body.messages).toEqual([
      { id: "u_sess_a", role: "user", content: "do the thing" },
      { id: "a_sess_a", role: "agent", content: "disk full", session_id: "sess_a" },
    ]);
  });

  it("surfaces in_flight_session_id while the tail turn is still running", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", status: "running", result_summary: undefined }),
    ]);
    const res = await request(h.app).get("/chat");
    expect(res.body.in_flight_session_id).toBe("sess_a");
  });

  it("omits in_flight_session_id once the tail turn is terminal", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", status: "succeeded", result_summary: "done" }),
    ]);
    const res = await request(h.app).get("/chat");
    expect(res.body.in_flight_session_id).toBeUndefined();
  });

  it("reports runtime_mismatch when the chain is pinned to a different CLI", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(
      fakeAgent({ runtime_config: { type: "codex" } } as Partial<Agent>),
    );
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", runtime_id: "rt_1", result_summary: "hi" }),
    ]);
    h.runtimeRepo.findById.mockResolvedValue({ id: "rt_1", cli: "claude" });

    const res = await request(h.app).get("/chat");
    expect(res.body.runtime_mismatch).toEqual({ pinned_cli: "claude", current_cli: "codex" });
  });

  it("omits runtime_mismatch when the pinned CLI matches the agent's current one", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", runtime_id: "rt_1", result_summary: "hi" }),
    ]);
    h.runtimeRepo.findById.mockResolvedValue({ id: "rt_1", cli: "claude" });

    const res = await request(h.app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("omits runtime_mismatch for an unrecognized pinned CLI rather than guessing", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", runtime_id: "rt_1", result_summary: "hi" }),
    ]);
    h.runtimeRepo.findById.mockResolvedValue({ id: "rt_1", cli: "some-future-cli" });

    const res = await request(h.app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
  });

  it("skips the runtime lookup entirely for an unpinned chain", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.listChatForAgent.mockResolvedValue([
      fakeSession({ id: "sess_a", runtime_id: undefined, result_summary: "hi" }),
    ]);
    const res = await request(h.app).get("/chat");
    expect(res.body.runtime_mismatch).toBeUndefined();
    expect(h.runtimeRepo.findById).not.toHaveBeenCalled();
  });
});

describe("POST /chat validation", () => {
  it("400s an empty or whitespace-only message", async () => {
    const h = harness();
    for (const message of ["", "   ", undefined]) {
      const res = await request(h.app).post("/chat").send({ message });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("message_required");
    }
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("404s when the caller has no primary agent", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);
    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
  });
});

describe("POST /chat idempotent replay", () => {
  const SID = "sess_abc123def456";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("replays a succeeded turn instead of spawning a second CLI run", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.findById.mockResolvedValue(
      fakeSession({ id: SID, status: "succeeded", result_summary: "cached reply" }),
    );

    const res = await request(h.app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.response).toBe("cached reply");
    expect(res.body.session_id).toBe(SID);
    // The whole point: no second dispatch, so no second charge.
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("replays a failed turn with the friendly failure message", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.findById.mockResolvedValue(
      fakeSession({ id: SID, status: "failed", error: "ran out of context" }),
    );

    const res = await request(h.app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.status).toBe("failed");
    expect(res.body.response).toBe("ran out of context");
  });

  it("409s when the replayed session is still running", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.findById.mockResolvedValue(fakeSession({ id: SID, status: "running" }));

    const res = await request(h.app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s rather than leaking a session owned by a different agent", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.findById.mockResolvedValue(
      fakeSession({ id: SID, agent_id: "agent_someone_else", result_summary: "their secrets" }),
    );

    const res = await request(h.app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
    expect(JSON.stringify(res.body)).not.toContain("their secrets");
  });

  it("falls through to a fresh run when the id is unknown", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.findById.mockResolvedValue(undefined);
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: SID }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: SID, result_summary: "fresh reply" }),
    );

    const res = await request(h.app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBeUndefined();
    // The caller's id is threaded through so the row is created with it.
    expect(h.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: SID }),
    );
  });

  it("falls through when a non-chat session happens to share the id", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.findById.mockResolvedValue(fakeSession({ id: SID, type: "task" }));
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: SID }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(fakeSession({ id: SID, result_summary: "ok" }));

    const res = await request(h.app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(200);
    expect(h.dispatchService.dispatchTask).toHaveBeenCalled();
  });

  it("falls through for a pending row — not yet terminal, not yet running", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    // Inserted by a dispatch that no daemon has claimed yet: there is no
    // result to replay and nothing in flight to 409 on, so the turn runs.
    h.sessionRepo.findById.mockResolvedValue(fakeSession({ id: SID, status: "pending" }));
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: SID }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: SID, result_summary: "ran at last" }),
    );

    const res = await request(h.app).post("/chat").send({ message: "hi", session_id: SID });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBeUndefined();
    expect(res.body.response).toBe("ran at last");
  });

  it("ignores a malformed session_id — no replay lookup, override not threaded", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_generated01" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_generated01", result_summary: "ok" }),
    );

    const res = await request(h.app)
      .post("/chat")
      .send({ message: "hi", session_id: "not-a-session-id" });
    expect(res.status).toBe(200);
    expect(h.sessionRepo.findById).not.toHaveBeenCalled();
    expect(h.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionIdOverride: undefined }),
    );
  });
});

describe("POST /chat dispatch", () => {
  it("sends a fresh resume reason for a first turn", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_a", result_summary: "hello back" }),
    );

    const res = await request(h.app).post("/chat").send({ message: "  hi  " });
    expect(res.status).toBe(200);
    expect(h.dispatchService.dispatchTask).toHaveBeenCalledWith({
      agentId: AGENT,
      // Trimmed before dispatch.
      intent: "hi",
      reason: { kind: "fresh" },
      type: "chat",
      sessionIdOverride: undefined,
    });
    expect(res.body.response).toBe("hello back");
  });

  it("threads prior_session_id as a chat_continuation so the CLI resumes", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_b" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_b", result_summary: "continued" }),
    );

    await request(h.app).post("/chat").send({ message: "more", prior_session_id: "sess_a" });
    expect(h.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_a" },
      }),
    );
  });

  it("503s when the session is daemon-bound but that daemon is offline", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: "rt_1",
    });
    h.hub.isOnline.mockReturnValue(false);

    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    // Fail fast instead of parking the socket for 90s on the resolver.
    expect(h.chatResolver.register).not.toHaveBeenCalled();
  });

  it("proceeds for a null-runtime session — the in-process executor claims it", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_a", result_summary: "ok" }),
    );

    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(h.hub.isOnline).not.toHaveBeenCalled();
  });

  it("maps a dispatch throw to a 500", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockRejectedValue(new Error("agent not found"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    spy.mockRestore();
  });

  it("504s when the resolver times out waiting on the agent", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockRejectedValue(new Error("chat resolver timeout after 90000ms"));

    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(504);
    expect(res.body.error).toBe("chat_turn_timeout");
    expect(res.body.timeout_ms).toBe(90_000);
  });

  it("maps a non-timeout resolver rejection to a 500", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockRejectedValue(new Error("resolver superseded"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    spy.mockRestore();
  });
});

describe("POST /chat onboarding flip", () => {
  it("stamps onboarding_completed_at on the first successful turn", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.personRepo.findById.mockResolvedValue(
      fakePerson({ onboarding_completed_at: undefined } as Partial<Person>),
    );
    h.personRepo.update.mockResolvedValue(fakePerson());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_a", status: "succeeded", result_summary: "welcome" }),
    );

    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(h.personRepo.update).toHaveBeenCalledWith(
      PERSON,
      expect.objectContaining({ onboarding_completed_at: expect.any(Date) }),
    );
  });

  it("does not flip the flag when the first turn fails", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.personRepo.findById.mockResolvedValue(
      fakePerson({ onboarding_completed_at: undefined } as Partial<Person>),
    );
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_a", status: "failed", error: "nope" }),
    );

    await request(h.app).post("/chat").send({ message: "hi" });
    expect(h.personRepo.update).not.toHaveBeenCalled();
  });

  it("leaves an already-onboarded person alone", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_a", result_summary: "ok" }),
    );

    await request(h.app).post("/chat").send({ message: "hi" });
    expect(h.personRepo.update).not.toHaveBeenCalled();
  });

  it("still answers 200 when the fire-and-forget flag write rejects", async () => {
    const h = harness();
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.personRepo.findById.mockResolvedValue(
      fakePerson({ onboarding_completed_at: undefined } as Partial<Person>),
    );
    h.personRepo.update.mockRejectedValue(new Error("pg down"));
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_a", result_summary: "welcome" }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.response).toBe("welcome");
    spy.mockRestore();
  });
});

describe("POST /chat rate limiting", () => {
  it("429s a concurrent second turn with Retry-After", async () => {
    // maxConcurrent: 1 and a slot already taken by another in-flight turn.
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, now: () => 0 });
    limiter.acquire(PERSON);

    const h = harness({ rateLimiter: limiter });
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());

    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("turn_in_flight");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(h.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("429s with rate_limited once the sliding window is full", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 5, maxPerWindow: 1, now: () => 0 });
    limiter.acquire(PERSON);

    const h = harness({ rateLimiter: limiter });
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());

    const res = await request(h.app).post("/chat").send({ message: "hi" });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limited");
    expect(res.body.retry_after_ms).toBeGreaterThan(0);
  });

  it("releases the slot after a successful turn, so the next one passes", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 10, now: () => 0 });
    const h = harness({ rateLimiter: limiter });
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_a", result_summary: "ok" }),
    );

    expect((await request(h.app).post("/chat").send({ message: "one" })).status).toBe(200);
    expect((await request(h.app).post("/chat").send({ message: "two" })).status).toBe(200);
  });

  it("releases the slot when dispatch throws — a 500 must not wedge the caller", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 10, now: () => 0 });
    const h = harness({ rateLimiter: limiter });
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockRejectedValueOnce(new Error("boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect((await request(h.app).post("/chat").send({ message: "one" })).status).toBe(500);

    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_a", result_summary: "ok" }),
    );
    // Would be 429 if the failed turn had leaked its slot.
    expect((await request(h.app).post("/chat").send({ message: "two" })).status).toBe(200);
    spy.mockRestore();
  });

  it("releases the slot when the daemon is offline", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 10, now: () => 0 });
    const h = harness({ rateLimiter: limiter });
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: "rt_1",
    });
    h.hub.isOnline.mockReturnValueOnce(false);

    expect((await request(h.app).post("/chat").send({ message: "one" })).status).toBe(503);

    h.hub.isOnline.mockReturnValue(true);
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_a", result_summary: "ok" }),
    );
    expect((await request(h.app).post("/chat").send({ message: "two" })).status).toBe(200);
  });

  it("releases the slot after a 504 timeout", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 10, now: () => 0 });
    const h = harness({ rateLimiter: limiter });
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockRejectedValueOnce(new Error("timeout"));

    expect((await request(h.app).post("/chat").send({ message: "one" })).status).toBe(504);

    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_a", result_summary: "ok" }),
    );
    expect((await request(h.app).post("/chat").send({ message: "two" })).status).toBe(200);
  });

  it("does not consume a slot on the validation and replay short-circuits", async () => {
    const limiter = new ChatRateLimiter({ maxConcurrent: 1, maxPerWindow: 2, now: () => 0 });
    const h = harness({ rateLimiter: limiter });
    h.agentRepo.findTopLevelForOwner.mockResolvedValue(fakeAgent());
    h.sessionRepo.findById.mockResolvedValue(
      fakeSession({ id: "sess_abc123def456", result_summary: "cached" }),
    );

    await request(h.app).post("/chat").send({ message: "" });
    await request(h.app)
      .post("/chat")
      .send({ message: "hi", session_id: "sess_abc123def456" });

    // Both short-circuited before acquire(), so the window is untouched.
    h.dispatchService.dispatchTask.mockResolvedValue({
      session: fakeSession({ id: "sess_a" }),
      runtime_id: null,
    });
    h.chatResolver.register.mockResolvedValue(
      fakeSession({ id: "sess_a", result_summary: "ok" }),
    );
    expect((await request(h.app).post("/chat").send({ message: "real" })).status).toBe(200);
  });
});
