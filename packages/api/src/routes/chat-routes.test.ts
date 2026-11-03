/**
 * `/chat` REST surface — unit tests with vitest fakes (no DB).
 *
 * `chat-internals.test.ts` already pins the three exported pure
 * functions (`groupIntoConversations`, `failureMessageFor`,
 * `chainToMessages`). This file covers the router those feed: four
 * endpoints plus the helpers reachable only through them
 * (`previewOf`, `detectRuntimeMismatch`, `toChatTurnResponse`,
 * `tryReplay`, `handleError`).
 *
 * The router is a closure over eight ports, so a bag of `vi.fn()`
 * fakes plus a stub auth middleware reaches every branch. Two areas
 * carry real money/correctness risk and get the most attention:
 *
 *   - **POST idempotency** (`tryReplay`): each live turn spawns a CLI
 *     subprocess, so a double-submit that slips past the replay check
 *     is a duplicate charge. The 403 (id collision), 409 (in flight)
 *     and 200-replay branches are pinned individually.
 *   - **Rate-limit slot accounting**: `rateOutcome.release()` runs on
 *     four different exits (503, dispatch throw, success, timeout).
 *     A leak wedges the person's chat at maxConcurrent=1 forever, so
 *     each exit asserts a *subsequent* turn still gets through rather
 *     than just checking the one response.
 *
 * The rate limiter is injected with maxConcurrent=1 and a frozen clock
 * so the concurrent-vs-throughput branches are selectable instead of
 * timing-dependent.
 */
import express, { json } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  Person,
  PersonRepository,
  Runtime,
  RuntimeRepository,
  Session,
  SessionRepository,
  SessionStatus,
} from "@beevibe/core";
import type { DispatchService } from "@beevibe/core/services/dispatch-service";
import type { ChatResolver } from "../runtime/chat-resolver.js";
import type { DaemonHub } from "../runtime/hub.js";
import { ChatRateLimiter } from "./chat-rate-limit.js";
import { createChatRouter, type ChatRoutesDeps } from "./chat.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const PERSON = "person_alice";
const AGENT_ID = "agt_team";

const AGENT: Agent = {
  id: AGENT_ID,
  name: "Beta",
  owner_id: PERSON,
  hierarchy_level: "team",
  runtime_config: { type: "claude" },
} as Agent;

/** A chat session row as `listChatForAgent` returns it. */
function chatRow(over: Partial<Session> & Pick<Session, "id">): Session {
  return {
    agent_id: AGENT_ID,
    type: "chat",
    status: "succeeded",
    intent: "hello",
    created_at: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as unknown as Session;
}

/** The terminal session the resolver hands back to the awaiting POST. */
function resolved(over: Partial<Session> = {}): Session {
  return chatRow({ id: "sess_dispatch01", status: "succeeded", ...over });
}

// ── Harness ──────────────────────────────────────────────────────────────

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
        agentId: AGENT_ID,
        hierarchyLevel: "team",
        personId: PERSON,
      };
    } else if (source === "agent") {
      req.caller = { source: "agent", agentId: AGENT_ID, hierarchyLevel: "ic" };
    }
    next();
  };
}

interface Ports {
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
  rateLimiter: ChatRateLimiter;
}

function makePorts(over: Partial<Ports> = {}): Ports {
  return {
    agentRepo: { findTopLevelForOwner: vi.fn(async () => AGENT) },
    personRepo: {
      // Already-onboarded by default; the flip tests opt into a null.
      findById: vi.fn(async () => ({
        id: PERSON,
        onboarding_completed_at: new Date("2026-01-01T00:00:00Z"),
      })),
      update: vi.fn(async () => undefined),
    },
    runtimeRepo: { findById: vi.fn(async () => undefined) },
    sessionRepo: {
      findById: vi.fn(async () => undefined),
      listChatForAgent: vi.fn(async () => []),
      softDeleteChatChain: vi.fn(async () => 0),
    },
    dispatchService: {
      dispatchTask: vi.fn(async () => ({
        session: chatRow({ id: "sess_dispatch01", status: "pending" }),
        runtime_id: null,
      })),
    },
    chatResolver: { register: vi.fn(async () => resolved()) },
    hub: { isOnline: vi.fn(() => true) },
    // maxConcurrent 1 is the production default; the frozen clock keeps
    // the sliding window from advancing between turns in one test.
    rateLimiter: new ChatRateLimiter({ maxConcurrent: 1, now: () => 1_000_000 }),
    ...over,
  };
}

function makeApp(ports: Ports, source: "human" | "agent" | "none" = "human") {
  const app = express();
  app.use(json());
  app.use(
    "/chat",
    createChatRouter({
      authMiddleware: stubAuth(source),
      agentRepo: ports.agentRepo as unknown as AgentRepository,
      personRepo: ports.personRepo as unknown as PersonRepository,
      runtimeRepo: ports.runtimeRepo as unknown as RuntimeRepository,
      sessionRepo: ports.sessionRepo as unknown as SessionRepository,
      dispatchService: ports.dispatchService as unknown as DispatchService,
      chatResolver: ports.chatResolver as unknown as ChatResolver,
      hub: ports.hub as unknown as DaemonHub,
      rateLimiter: ports.rateLimiter,
    } satisfies ChatRoutesDeps),
  );
  return app;
}

let ports: Ports;

beforeEach(() => {
  vi.restoreAllMocks();
  ports = makePorts();
});

// ── auth gate ────────────────────────────────────────────────────────────

describe("/chat human gate", () => {
  const cases = [
    ["GET", "/chat"],
    ["GET", "/chat/conversations"],
    ["POST", "/chat"],
    ["DELETE", "/chat/conversations/sess_head000001"],
  ] as const;

  for (const [method, path] of cases) {
    it(`403s an agent caller on ${method} ${path}`, async () => {
      const app = makeApp(ports, "agent");
      const res = await request(app)[method.toLowerCase() as "get"](path).send({
        message: "hi",
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("human_required");
    });

    it(`403s an unauthenticated caller on ${method} ${path}`, async () => {
      const app = makeApp(ports, "none");
      const res = await request(app)[method.toLowerCase() as "get"](path).send({
        message: "hi",
      });
      expect(res.status).toBe(403);
    });
  }

  it("does not reach the ports when the gate rejects", async () => {
    await request(makeApp(ports, "agent")).post("/chat").send({ message: "hi" });
    expect(ports.agentRepo.findTopLevelForOwner).not.toHaveBeenCalled();
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });
});

// ── GET /chat/conversations ──────────────────────────────────────────────

describe("GET /chat/conversations", () => {
  it("returns an empty list when the caller has no primary agent", async () => {
    ports.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).get("/chat/conversations");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, conversations: [] });
    // No agent means nothing to list — don't spend a query finding out.
    expect(ports.sessionRepo.listChatForAgent).not.toHaveBeenCalled();
  });

  it("summarizes each chain with its head title, turn count and tail", async () => {
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      chatRow({
        id: "sess_head000001",
        intent: "first question",
        result_summary: "first answer",
        created_at: new Date("2026-01-01T10:00:00Z"),
      }),
      chatRow({
        id: "sess_tail000001",
        prior_session_id: "sess_head000001",
        intent: "follow-up",
        result_summary: "second answer",
        created_at: new Date("2026-01-01T10:05:00Z"),
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat/conversations");

    expect(res.body.conversations).toEqual([
      {
        head_id: "sess_head000001",
        // Title is the *head's* intent — the thread keeps its original
        // name as turns accumulate.
        title: "first question",
        turn_count: 2,
        last_at: "2026-01-01T10:05:00.000Z",
        last_preview: "second answer",
      },
    ]);
  });

  it("reads with the bounded fetch limit, scoped to the primary agent", async () => {
    await request(makeApp(ports)).get("/chat/conversations");
    expect(ports.sessionRepo.listChatForAgent).toHaveBeenCalledWith(AGENT_ID, 400);
  });

  it("truncates a long head intent to the shared thread-title cap", async () => {
    const intent = "x".repeat(200);
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_long000001", intent }),
    ]);

    const title = (await request(makeApp(ports)).get("/chat/conversations")).body.conversations[0]
      .title;

    // CHAT_THREAD_TITLE_MAX is 80 and `truncate` spends one char on the
    // ellipsis, so the cap is exactly 80 including it. The agent detail
    // page derives the same field from the same helper — if these drift
    // one thread shows under two different titles.
    expect(title).toHaveLength(80);
    expect(title).toBe("x".repeat(79) + "…");
  });

  it("orders conversations by latest activity, newest first", async () => {
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_old000001", created_at: new Date("2026-01-01T09:00:00Z") }),
      chatRow({ id: "sess_new000001", created_at: new Date("2026-01-01T11:00:00Z") }),
    ]);

    const res = await request(makeApp(ports)).get("/chat/conversations");

    expect(res.body.conversations.map((c: { head_id: string }) => c.head_id)).toEqual([
      "sess_new000001",
      "sess_old000001",
    ]);
  });

  it("caps the list at 50 conversations even when more rows come back", async () => {
    ports.sessionRepo.listChatForAgent.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) =>
        chatRow({
          id: `sess_c${String(i).padStart(8, "0")}`,
          created_at: new Date(Date.UTC(2026, 0, 1, 0, i)),
        }),
      ),
    );

    const res = await request(makeApp(ports)).get("/chat/conversations");

    // The fetch limit (400) is deliberately well above the display cap,
    // so the slice — not the query — is what bounds the response.
    expect(res.body.conversations).toHaveLength(50);
  });

  describe("last_preview", () => {
    async function previewFor(over: Partial<Session>) {
      ports.sessionRepo.listChatForAgent.mockResolvedValue([
        chatRow({ id: "sess_prev000001", ...over }),
      ]);
      const res = await request(makeApp(ports)).get("/chat/conversations");
      return res.body.conversations[0].last_preview as string;
    }

    it("prefers the result summary, with directives stripped", async () => {
      const preview = await previewFor({
        result_summary: 'Done.<suggest_action label="Next" />',
        intent: "ignored",
      });
      // The preview is chrome in a list — directive markup would leak
      // raw XML into the sidebar.
      expect(preview).toBe("Done.");
    });

    it("falls back to the error when there is no summary", async () => {
      expect(await previewFor({ status: "failed", error: "boom" })).toBe("boom");
    });

    it("falls back to the intent when there is neither", async () => {
      expect(await previewFor({ intent: "just the question" })).toBe("just the question");
    });

    it("collapses newlines and runs of whitespace into single spaces", async () => {
      expect(await previewFor({ result_summary: "  a\n\nb\t c  " })).toBe("a b c");
    });

    it("truncates an over-long preview to 140 chars including the ellipsis", async () => {
      const preview = await previewFor({ result_summary: "y".repeat(400) });
      expect(preview).toHaveLength(140);
      expect(preview.endsWith("…")).toBe(true);
    });

    it("leaves a preview exactly at the limit untouched", async () => {
      const preview = await previewFor({ result_summary: "z".repeat(140) });
      expect(preview).toBe("z".repeat(140));
    });
  });
});

// ── DELETE /chat/conversations/:headId ───────────────────────────────────

describe("DELETE /chat/conversations/:headId", () => {
  it("soft-deletes the chain scoped to the caller's primary agent", async () => {
    ports.sessionRepo.softDeleteChatChain.mockResolvedValue(3);

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head000001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 3 });
    // The agent scope is the guard against deleting someone else's
    // history via a guessed/colliding head id.
    expect(ports.sessionRepo.softDeleteChatChain).toHaveBeenCalledWith("sess_head000001", AGENT_ID);
  });

  it("is idempotent — re-deleting an already-deleted chain still 200s", async () => {
    ports.sessionRepo.softDeleteChatChain.mockResolvedValue(0);

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head000001");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: 0 });
  });

  it("404s when the caller has no primary agent", async () => {
    ports.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head000001");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "agent_not_found" });
    expect(ports.sessionRepo.softDeleteChatChain).not.toHaveBeenCalled();
  });

  it("maps a repo failure to a generic 500 carrying a request id", async () => {
    ports.sessionRepo.softDeleteChatChain.mockRejectedValue(new Error("deadlock detected"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head000001");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    // The internal detail stays in the log, indexed by the id the user
    // can paste into a bug report.
    expect(res.body.request_id).toMatch(/^req_/);
    expect(res.body.message).not.toContain("deadlock");
    expect(errSpy.mock.calls[0]?.[0]).toContain(res.body.request_id);
  });

  it("still 500s cleanly when the repo throws a non-Error value", async () => {
    // `pg` and some drivers can reject with a bare string; `err.stack`
    // would be undefined and the handler must not throw while logging.
    ports.sessionRepo.softDeleteChatChain.mockRejectedValue("just a string");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head000001");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(errSpy.mock.calls[0]?.[1]).toBe("just a string");
  });

  it("logs the message when the error carries no stack", async () => {
    const stackless = new Error("no stack here");
    stackless.stack = undefined;
    ports.sessionRepo.softDeleteChatChain.mockRejectedValue(stackless);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(makeApp(ports)).delete("/chat/conversations/sess_head000001");

    expect(res.status).toBe(500);
    expect(errSpy.mock.calls[0]?.[1]).toBe("no stack here");
  });
});

// ── GET /chat ────────────────────────────────────────────────────────────

describe("GET /chat", () => {
  it("returns a null agent and empty history when none is provisioned", async () => {
    ports.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);

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

  it("rehydrates the most recent conversation by default", async () => {
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      chatRow({
        id: "sess_old000001",
        intent: "older thread",
        result_summary: "old answer",
        created_at: new Date("2026-01-01T09:00:00Z"),
      }),
      chatRow({
        id: "sess_new000001",
        intent: "newer thread",
        result_summary: "new answer",
        created_at: new Date("2026-01-01T11:00:00Z"),
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat");

    expect(res.body.agent).toEqual({ id: AGENT_ID, name: "Beta", hierarchy: "team" });
    expect(res.body.conversation_id).toBe("sess_new000001");
    expect(res.body.prior_session_id).toBe("sess_new000001");
    expect(res.body.messages.map((m: { content: string }) => m.content)).toEqual([
      "newer thread",
      "new answer",
    ]);
  });

  it("selects the chain named by ?c=", async () => {
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      chatRow({
        id: "sess_old000001",
        intent: "older thread",
        created_at: new Date("2026-01-01T09:00:00Z"),
      }),
      chatRow({
        id: "sess_new000001",
        intent: "newer thread",
        created_at: new Date("2026-01-01T11:00:00Z"),
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat?c=sess_old000001");

    expect(res.body.conversation_id).toBe("sess_old000001");
    expect(res.body.messages[0].content).toBe("older thread");
  });

  it("returns an empty history (not a 404) for an unknown ?c=", async () => {
    ports.sessionRepo.listChatForAgent.mockResolvedValue([chatRow({ id: "sess_head000001" })]);

    const res = await request(makeApp(ports)).get("/chat?c=sess_nosuch0001");

    // The chat UI renders its empty state off this shape; a 404 would
    // surface as an error toast instead.
    expect(res.status).toBe(200);
    expect(res.body.agent).not.toBeNull();
    expect(res.body.messages).toEqual([]);
    expect(res.body.conversation_id).toBeNull();
    expect(res.body.prior_session_id).toBeNull();
  });

  it("ignores a repeated ?c= rather than matching on an array", async () => {
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_head000001", intent: "the one chain" }),
    ]);

    // `typeof req.query.c === "string"` is false for `?c=a&c=b`, so the
    // handler falls back to the most recent chain.
    const res = await request(makeApp(ports)).get("/chat?c=sess_head000001&c=sess_other0001");

    expect(res.body.conversation_id).toBe("sess_head000001");
  });

  it("keeps only the last 25 sessions of a long chain", async () => {
    const sessions = Array.from({ length: 40 }, (_, i) =>
      chatRow({
        id: `sess_t${String(i).padStart(8, "0")}`,
        prior_session_id: i === 0 ? undefined : `sess_t${String(i - 1).padStart(8, "0")}`,
        intent: `turn ${i}`,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, i)),
      }),
    );
    ports.sessionRepo.listChatForAgent.mockResolvedValue(sessions);

    const res = await request(makeApp(ports)).get("/chat");

    // HISTORY_LIMIT is 50 *messages* and each session yields up to two,
    // so the window is 25 sessions — the tail, since that's what the
    // user is looking at.
    const userTurns = res.body.messages.filter((m: { role: string }) => m.role === "user");
    expect(userTurns).toHaveLength(25);
    expect(userTurns[0].content).toBe("turn 15");
    expect(userTurns[24].content).toBe("turn 39");
    // The chain identity is still the real head, not the window's edge.
    expect(res.body.conversation_id).toBe("sess_t00000000");
    expect(res.body.prior_session_id).toBe("sess_t00000039");
  });

  it("carries every directive channel through a rehydrated agent message", async () => {
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      chatRow({
        id: "sess_rich000001",
        intent: "do things",
        result_summary:
          'Filed task_abc123def456.<open_view path="/tasks" label="Tasks" />' +
          '<suggest_action label="Review it" />' +
          '<repo_card repo_url="https://github.com/foo/bar" />',
      }),
    ]);

    const res = await request(makeApp(ports)).get("/chat");

    // A reload has to reproduce the same rich message the live POST
    // returned — otherwise view chips and action buttons vanish the
    // moment the user refreshes.
    const agentMsg = res.body.messages.find((m: { role: string }) => m.role === "agent");
    expect(agentMsg.content).toBe("Filed task_abc123def456.");
    expect(agentMsg.view_refs).toEqual(["task_abc123def456"]);
    expect(agentMsg.open_view).toEqual({ path: "/tasks", label: "Tasks" });
    expect(agentMsg.suggested_actions).toEqual([{ label: "Review it" }]);
    expect(agentMsg.repo_cards).toHaveLength(1);
  });

  it("omits the optional directive keys when the summary is plain prose", async () => {
    ports.sessionRepo.listChatForAgent.mockResolvedValue([
      chatRow({ id: "sess_plain00001", result_summary: "just prose" }),
    ]);

    const res = await request(makeApp(ports)).get("/chat");

    const agentMsg = res.body.messages.find((m: { role: string }) => m.role === "agent");
    expect(agentMsg).not.toHaveProperty("view_refs");
    expect(agentMsg).not.toHaveProperty("open_view");
    expect(agentMsg).not.toHaveProperty("suggested_actions");
    expect(agentMsg).not.toHaveProperty("repo_cards");
  });

  describe("in_flight_session_id", () => {
    async function inFlightFor(status: SessionStatus) {
      ports.sessionRepo.listChatForAgent.mockResolvedValue([
        chatRow({ id: "sess_tail000001", status }),
      ]);
      const res = await request(makeApp(ports)).get("/chat");
      return res.body.in_flight_session_id;
    }

    it.each(["pending", "running"] as const)(
      "surfaces the tail session when %s",
      async (status) => {
        // Without this the "agent is thinking" indicator vanishes as soon
        // as the user navigates away from /chat and back.
        expect(await inFlightFor(status)).toBe("sess_tail000001");
      },
    );

    it.each(["succeeded", "failed", "cancelled"] as const)(
      "is absent when the tail is %s",
      async (s) => {
        expect(await inFlightFor(s)).toBeUndefined();
      },
    );
  });

  describe("runtime_mismatch", () => {
    function pinChainTo(cli: string | undefined, runtimeId = "rt_1") {
      ports.sessionRepo.listChatForAgent.mockResolvedValue([
        chatRow({ id: "sess_tail000001", runtime_id: runtimeId }),
      ]);
      ports.runtimeRepo.findById.mockResolvedValue(
        cli === undefined ? undefined : ({ id: runtimeId, cli } as Runtime),
      );
    }

    it("reports the pinned and current CLI when they differ", async () => {
      pinChainTo("codex");

      const res = await request(makeApp(ports)).get("/chat");

      // The next turn still runs on codex (resume needs the original
      // .jsonl); the user just needs to know why their new runtime
      // isn't being used.
      expect(res.body.runtime_mismatch).toEqual({
        pinned_cli: "codex",
        current_cli: "claude",
      });
      expect(ports.runtimeRepo.findById).toHaveBeenCalledWith("rt_1");
    });

    it("is absent when the chain is pinned to the agent's current CLI", async () => {
      pinChainTo("claude");
      const res = await request(makeApp(ports)).get("/chat");
      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it("is absent when the pinned runtime row is gone", async () => {
      pinChainTo(undefined);
      const res = await request(makeApp(ports)).get("/chat");
      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it("is absent for an unrecognized cli value on the runtime row", async () => {
      // A runtime row written by a newer daemon than this api knows
      // about: say nothing rather than claim a mismatch against a CLI
      // we can't name.
      pinChainTo("some-future-cli");
      const res = await request(makeApp(ports)).get("/chat");
      expect(res.body.runtime_mismatch).toBeUndefined();
    });

    it("skips the runtime lookup entirely when the tail has no runtime_id", async () => {
      ports.sessionRepo.listChatForAgent.mockResolvedValue([chatRow({ id: "sess_tail000001" })]);

      const res = await request(makeApp(ports)).get("/chat");

      expect(res.body.runtime_mismatch).toBeUndefined();
      expect(ports.runtimeRepo.findById).not.toHaveBeenCalled();
    });
  });
});

// ── POST /chat — validation ──────────────────────────────────────────────

describe("POST /chat validation", () => {
  it.each([
    ["an absent message", {}],
    ["an empty message", { message: "" }],
    ["a whitespace-only message", { message: "   \n\t " }],
    ["a non-string message", { message: 42 }],
  ])("400s on %s", async (_label, body) => {
    const res = await request(makeApp(ports)).post("/chat").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
    // Validation precedes the agent lookup — a blank submit shouldn't
    // cost a query, let alone a spawn.
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("400s rather than throwing when the request has no parsed body at all", async () => {
    // No json() middleware in front of the router — `req.body` is
    // undefined, and the `?? {}` fallback is what keeps this a 400
    // instead of a TypeError-driven 500.
    const app = express();
    app.use(
      "/chat",
      createChatRouter({
        authMiddleware: stubAuth("human"),
        agentRepo: ports.agentRepo as unknown as AgentRepository,
        personRepo: ports.personRepo as unknown as PersonRepository,
        runtimeRepo: ports.runtimeRepo as unknown as RuntimeRepository,
        sessionRepo: ports.sessionRepo as unknown as SessionRepository,
        dispatchService: ports.dispatchService as unknown as DispatchService,
        chatResolver: ports.chatResolver as unknown as ChatResolver,
        hub: ports.hub as unknown as DaemonHub,
        rateLimiter: ports.rateLimiter,
      }),
    );

    const res = await request(app).post("/chat");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("message_required");
  });

  it("dispatches the trimmed message", async () => {
    await request(makeApp(ports)).post("/chat").send({ message: "  ship it  " });

    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "ship it", type: "chat", agentId: AGENT_ID }),
    );
  });

  it("404s when the caller has no primary agent", async () => {
    ports.agentRepo.findTopLevelForOwner.mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_primary_agent");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("sends a fresh resume reason for a first turn", async () => {
    await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ reason: { kind: "fresh" } }),
    );
  });

  it("sends a chat_continuation reason when prior_session_id is given", async () => {
    await request(makeApp(ports))
      .post("/chat")
      .send({ message: "and then?", prior_session_id: "sess_prior00001" });

    // dispatchService reads this to pin the runtime and pass
    // `--resume <prior.cli_session_id>` to the spawn.
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: { kind: "chat_continuation", prior_session_id: "sess_prior00001" },
      }),
    );
  });

  it("ignores a non-string prior_session_id", async () => {
    await request(makeApp(ports)).post("/chat").send({ message: "hi", prior_session_id: 7 });

    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
      expect.objectContaining({ reason: { kind: "fresh" } }),
    );
  });

  describe("client-supplied session_id", () => {
    it("passes a well-formed id through as the session id override", async () => {
      await request(makeApp(ports))
        .post("/chat")
        .send({ message: "hi", session_id: "sess_abc123XYZ789" });

      expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
        expect.objectContaining({ sessionIdOverride: "sess_abc123XYZ789" }),
      );
    });

    it.each([
      ["a bad prefix", "task_abc123XYZ789"],
      ["too few chars", "sess_abc123"],
      ["too many chars", "sess_abc123XYZ7890"],
      ["a non-alphanumeric body", "sess_abc-123XYZ78"],
      ["a non-string", 12345],
    ])("ignores %s instead of trusting it", async (_label, session_id) => {
      await request(makeApp(ports)).post("/chat").send({ message: "hi", session_id });

      // A malformed id must not become a row id, and must not be looked
      // up as one — otherwise the replay path keys off client input.
      expect(ports.sessionRepo.findById).not.toHaveBeenCalled();
      expect(ports.dispatchService.dispatchTask).toHaveBeenCalledWith(
        expect.objectContaining({ sessionIdOverride: undefined }),
      );
    });
  });
});

// ── POST /chat — idempotent replay ───────────────────────────────────────

describe("POST /chat idempotent replay", () => {
  const SID = "sess_abc123XYZ789";

  async function postWithId(body: Record<string, unknown> = {}) {
    return request(makeApp(ports))
      .post("/chat")
      .send({ message: "hi", session_id: SID, ...body });
  }

  it.each(["succeeded", "failed"] as const)(
    "replays a %s session instead of spawning again",
    async (status) => {
      ports.sessionRepo.findById.mockResolvedValue(
        chatRow({ id: SID, status, result_summary: "the original answer" }),
      );

      const res = await postWithId();

      expect(res.status).toBe(200);
      expect(res.body.replayed).toBe(true);
      expect(res.body.session_id).toBe(SID);
      // The whole point: a retried POST must not cost a second CLI run.
      expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
      expect(ports.chatResolver.register).not.toHaveBeenCalled();
    },
  );

  it("renders a replayed failure through the friendly failure mapping", async () => {
    ports.sessionRepo.findById.mockResolvedValue(
      chatRow({ id: SID, status: "failed", error: "ENOSPC: no space left on device" }),
    );

    const res = await postWithId();

    expect(res.body.status).toBe("failed");
    expect(res.body.response).toBe("ENOSPC: no space left on device");
  });

  it("409s while the session is still running", async () => {
    ports.sessionRepo.findById.mockResolvedValue(chatRow({ id: SID, status: "running" }));

    const res = await postWithId();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_in_flight");
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("403s when the session id belongs to another caller's agent", async () => {
    ports.sessionRepo.findById.mockResolvedValue(
      chatRow({ id: SID, agent_id: "agt_someone_else", status: "succeeded" }),
    );

    const res = await postWithId();

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("session_belongs_to_other_caller");
    // Never replay another agent's transcript back to this caller.
    expect(res.body.response).toBeUndefined();
    expect(ports.dispatchService.dispatchTask).not.toHaveBeenCalled();
  });

  it("falls through to a live turn when the row does not exist yet", async () => {
    ports.sessionRepo.findById.mockResolvedValue(undefined);

    const res = await postWithId();

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBeUndefined();
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledOnce();
  });

  it("falls through when the row is not a chat session", async () => {
    // A task/mesh session that happens to collide on id isn't a chat
    // turn to replay.
    ports.sessionRepo.findById.mockResolvedValue(
      chatRow({ id: SID, type: "task", status: "succeeded" }),
    );

    const res = await postWithId();

    expect(res.status).toBe(200);
    expect(res.body.replayed).toBeUndefined();
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledOnce();
  });

  it("falls through for a pending row — nothing has been produced to replay", async () => {
    ports.sessionRepo.findById.mockResolvedValue(chatRow({ id: SID, status: "pending" }));

    const res = await postWithId();

    expect(res.status).toBe(200);
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledOnce();
  });

  it("replays without consuming a rate-limit slot", async () => {
    ports.sessionRepo.findById.mockResolvedValue(
      chatRow({ id: SID, status: "succeeded", result_summary: "answer" }),
    );
    const app = makeApp(ports);

    await request(app).post("/chat").send({ message: "hi", session_id: SID });
    const second = await request(app).post("/chat").send({ message: "hi", session_id: SID });

    // The replay check runs *before* `acquire`, so a double-submit
    // can't also burn the person's single concurrent slot.
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
  });
});

// ── POST /chat — rate limiting ───────────────────────────────────────────

describe("POST /chat rate limiting", () => {
  it("429s a second concurrent turn with a Retry-After header", async () => {
    // Hold the first turn open so its slot is still taken.
    let release!: () => void;
    ports.chatResolver.register.mockImplementation(
      () => new Promise<Session>((r) => (release = () => r(resolved()))),
    );
    const app = makeApp(ports);

    // `.then()` is what actually fires a supertest request — without it
    // the first turn never starts and never holds the slot.
    const first = request(app)
      .post("/chat")
      .send({ message: "one" })
      .then((r) => r);
    await vi.waitFor(() => expect(ports.chatResolver.register).toHaveBeenCalled());
    const second = await request(app).post("/chat").send({ message: "two" });

    expect(second.status).toBe(429);
    expect(second.body.error).toBe("turn_in_flight");
    expect(second.body.retry_after_ms).toBe(1000);
    expect(second.headers["retry-after"]).toBe("1");
    // The rejected turn must not have reached dispatch.
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledOnce();

    release();
    await first;
  });

  it("429s with a throughput reason once the sliding window is full", async () => {
    // Window of one turn per minute, clock frozen — the second turn is
    // over the window cap rather than merely concurrent.
    ports.rateLimiter = new ChatRateLimiter({
      maxConcurrent: 1,
      maxPerWindow: 1,
      windowMs: 60_000,
      now: () => 1_000_000,
    });
    const app = makeApp(ports);

    await request(app).post("/chat").send({ message: "one" });
    const second = await request(app).post("/chat").send({ message: "two" });

    expect(second.status).toBe(429);
    expect(second.body.error).toBe("rate_limited");
    expect(second.body.retry_after_ms).toBe(60_000);
    expect(second.headers["retry-after"]).toBe("60");
  });

  it("ships a working default limiter when no override is injected", async () => {
    // Production builds the limiter itself; maxConcurrent defaults to 1,
    // so the second overlapping turn is throttled with no injection.
    const app = express();
    app.use(json());
    let release!: () => void;
    ports.chatResolver.register.mockImplementation(
      () => new Promise<Session>((r) => (release = () => r(resolved()))),
    );
    app.use(
      "/chat",
      createChatRouter({
        authMiddleware: stubAuth("human"),
        agentRepo: ports.agentRepo as unknown as AgentRepository,
        personRepo: ports.personRepo as unknown as PersonRepository,
        runtimeRepo: ports.runtimeRepo as unknown as RuntimeRepository,
        sessionRepo: ports.sessionRepo as unknown as SessionRepository,
        dispatchService: ports.dispatchService as unknown as DispatchService,
        chatResolver: ports.chatResolver as unknown as ChatResolver,
        hub: ports.hub as unknown as DaemonHub,
      }),
    );

    const first = request(app)
      .post("/chat")
      .send({ message: "one" })
      .then((r) => r);
    await vi.waitFor(() => expect(ports.chatResolver.register).toHaveBeenCalled());
    const second = await request(app).post("/chat").send({ message: "two" });

    expect(second.status).toBe(429);
    expect(second.body.error).toBe("turn_in_flight");

    release();
    await first;
  });

  it("frees the slot after a successful turn", async () => {
    const app = makeApp(ports);

    const first = await request(app).post("/chat").send({ message: "one" });
    const second = await request(app).post("/chat").send({ message: "two" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(ports.dispatchService.dispatchTask).toHaveBeenCalledTimes(2);
  });
});

// ── POST /chat — dispatch and daemon reachability ────────────────────────

describe("POST /chat dispatch", () => {
  it("503s when the session is bound to an offline daemon", async () => {
    ports.dispatchService.dispatchTask.mockResolvedValue({
      session: chatRow({ id: "sess_dispatch01", status: "pending" }),
      runtime_id: "rt_offline",
    });
    ports.hub.isOnline.mockReturnValue(false);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    // Without this the session sits pending and the user waits out the
    // full 90s resolver timeout for a 504 that explains nothing.
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_offline");
    expect(ports.hub.isOnline).toHaveBeenCalledWith("rt_offline");
    expect(ports.chatResolver.register).not.toHaveBeenCalled();
  });

  it("frees the rate-limit slot on the offline path", async () => {
    ports.dispatchService.dispatchTask.mockResolvedValue({
      session: chatRow({ id: "sess_dispatch01", status: "pending" }),
      runtime_id: "rt_offline",
    });
    ports.hub.isOnline.mockReturnValue(false);
    const app = makeApp(ports);

    await request(app).post("/chat").send({ message: "one" });
    const second = await request(app).post("/chat").send({ message: "two" });

    // A leak here would wedge the person's chat at maxConcurrent=1
    // behind a 429 until the process restarted.
    expect(second.status).toBe(503);
  });

  it("proceeds for a null runtime_id — the in-process executor claims it", async () => {
    ports.dispatchService.dispatchTask.mockResolvedValue({
      session: chatRow({ id: "sess_dispatch01", status: "pending" }),
      runtime_id: null,
    });

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(ports.hub.isOnline).not.toHaveBeenCalled();
    expect(ports.chatResolver.register).toHaveBeenCalledWith("sess_dispatch01", 90_000);
  });

  it("500s and frees the slot when dispatch throws", async () => {
    ports.dispatchService.dispatchTask.mockRejectedValue(new Error("no capacity"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = makeApp(ports);

    const res = await request(app).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(res.body.request_id).toMatch(/^req_/);
    // Slot released: the retry gets a fresh attempt, not a 429.
    const retry = await request(app).post("/chat").send({ message: "hi" });
    expect(retry.status).toBe(500);
  });
});

// ── POST /chat — resolution ──────────────────────────────────────────────

describe("POST /chat resolution", () => {
  it("returns the resolved turn with the agent envelope", async () => {
    ports.chatResolver.register.mockResolvedValue(
      resolved({ status: "succeeded", result_summary: "here you go" }),
    );

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      agent: { id: AGENT_ID, name: "Beta", hierarchy: "team" },
      session_id: "sess_dispatch01",
      response: "here you go",
      status: "succeeded",
      view_refs: [],
    });
    expect(res.body.replayed).toBeUndefined();
  });

  it("splits directives out of the response body", async () => {
    ports.chatResolver.register.mockResolvedValue(
      resolved({
        result_summary:
          'Opening it.<open_view path="/agents" label="Agents" />' +
          '<suggest_action label="Spawn one" prompt="spawn an IC" />',
      }),
    );

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.body.response).toBe("Opening it.");
    expect(res.body.open_view).toEqual({ path: "/agents", label: "Agents" });
    expect(res.body.suggested_actions).toEqual([{ label: "Spawn one", prompt: "spawn an IC" }]);
  });

  it("carries repo cards on the live turn response", async () => {
    ports.chatResolver.register.mockResolvedValue(
      resolved({
        result_summary:
          'Found one.<repo_card repo_url="https://github.com/foo/bar" stars="1,234" />',
      }),
    );

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.body.response).toBe("Found one.");
    expect(res.body.repo_cards).toHaveLength(1);
    expect(res.body.repo_cards[0]).toMatchObject({
      repo_url: "https://github.com/foo/bar",
    });
  });

  it("maps a failed turn through the friendly failure message", async () => {
    ports.chatResolver.register.mockResolvedValue(
      resolved({ status: "failed", error: "CLI exited with code 1" }),
    );

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    // The bare exit line tells the user nothing, so it's replaced with
    // a pointer at the daemon log.
    expect(res.body.response).toContain("beevibe-daemon start");
  });

  it("504s when the resolver times out", async () => {
    ports.chatResolver.register.mockRejectedValue(
      new Error("chat resolver timeout (90000ms) for sess_dispatch01"),
    );

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(504);
    expect(res.body.error).toBe("chat_turn_timeout");
    expect(res.body.timeout_ms).toBe(90_000);
  });

  it("frees the rate-limit slot after a timeout", async () => {
    ports.chatResolver.register.mockRejectedValue(new Error("chat resolver timeout (90000ms)"));
    const app = makeApp(ports);

    await request(app).post("/chat").send({ message: "one" });
    const second = await request(app).post("/chat").send({ message: "two" });

    expect(second.status).toBe(504);
  });

  it("500s on a non-timeout resolver failure", async () => {
    ports.chatResolver.register.mockRejectedValue(new Error("resolver collision"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });
});

// ── POST /chat — onboarding flip ─────────────────────────────────────────

describe("POST /chat onboarding completion", () => {
  it("flips onboarding_completed_at on the first successful turn", async () => {
    ports.personRepo.findById.mockResolvedValue({
      id: PERSON,
      onboarding_completed_at: null,
    } as unknown as Person);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(ports.personRepo.update).toHaveBeenCalledWith(PERSON, {
        onboarding_completed_at: expect.any(Date),
      }),
    );
  });

  it("does not re-flip for an already-onboarded person", async () => {
    await request(makeApp(ports)).post("/chat").send({ message: "hi" });
    expect(ports.personRepo.update).not.toHaveBeenCalled();
  });

  it("does not flip when the first turn fails", async () => {
    ports.personRepo.findById.mockResolvedValue({
      id: PERSON,
      onboarding_completed_at: null,
    } as unknown as Person);
    ports.chatResolver.register.mockResolvedValue(
      resolved({ status: "failed", error: "spawn failed" }),
    );

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    // The welcome wizard should still be waiting for a turn that worked.
    expect(res.status).toBe(200);
    expect(ports.personRepo.update).not.toHaveBeenCalled();
  });

  it("does not flip when the person row is missing", async () => {
    ports.personRepo.findById.mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    // `!person?.onboarding_completed_at` is true for a missing row, but
    // there is nothing to update — the write would throw.
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(ports.personRepo.update).toHaveBeenCalled());
  });

  it("still answers the turn when the onboarding write fails", async () => {
    ports.personRepo.findById.mockResolvedValue({
      id: PERSON,
      onboarding_completed_at: null,
    } as unknown as Person);
    ports.personRepo.update.mockRejectedValue(new Error("write conflict"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    // Fire-and-forget by design: a flaky flag write must not turn a
    // good turn into a 500.
    expect(res.status).toBe(200);
    expect(res.body.response).toBeDefined();
    await vi.waitFor(() =>
      expect(errSpy).toHaveBeenCalledWith(
        "[chat route] onboarding_completed_at flip failed:",
        "write conflict",
      ),
    );
  });

  it("stringifies a non-Error rejection from the onboarding write", async () => {
    ports.personRepo.findById.mockResolvedValue({
      id: PERSON,
      onboarding_completed_at: null,
    } as unknown as Person);
    ports.personRepo.update.mockRejectedValue("connection reset");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(makeApp(ports)).post("/chat").send({ message: "hi" });

    expect(res.status).toBe(200);
    await vi.waitFor(() =>
      expect(errSpy).toHaveBeenCalledWith(
        "[chat route] onboarding_completed_at flip failed:",
        "connection reset",
      ),
    );
  });
});
