/**
 * /room REST surface + addressee resolution — unit tests with vitest
 * fakes (no DB).
 *
 * The router is a closure over seven ports, so a bag of `vi.fn()` repos
 * plus a stub auth middleware reaches every branch: the human gate,
 * membership 404s, the create/join/invite team-agent attach, the
 * fire-and-forget agent run behind `POST /:id/message`, and the
 * `@mention` / vocative / name / team-keyword ladder in
 * `resolveAddressees`.
 *
 * `AgentSession` is mocked at the module boundary — the background run
 * is the one path that would otherwise spawn a CLI. Everything else
 * (`processResponse`, `failureMessageFor`, `teamAgentRoutingDirective`)
 * runs for real, since those are pure and their output is part of the
 * wire contract this suite is pinning.
 */
import express, { json } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  AgentRepository,
  PersonRepository,
  Room,
  RoomMember,
  RoomMessage,
  RoomRepository,
  RuntimeRegistry,
  Session,
  SessionEvent,
  SessionEventRepository,
  SessionRepository,
  WorkspaceManager,
} from "@beevibe/core";
import type { MemoryAgent } from "@beevibe/core/services/memory";

// ── AgentSession stub ────────────────────────────────────────────────────
// `runMentionedAgents` news up an AgentSession and calls `.run()`. Mock
// the class but keep `teamAgentRoutingDirective` real — the router
// concatenates its output into extraSystemPromptAppend and the tests
// below assert on that string.
const sessionRun = vi.fn();
vi.mock("@beevibe/core/services/agent-session", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@beevibe/core/services/agent-session")
  >();
  return {
    ...actual,
    AgentSession: class {
      run = sessionRun;
    },
  };
});

const { createRoomRouter, resolveAddressees } = await import("./room.js");

// ── Fixtures ─────────────────────────────────────────────────────────────

const PERSON = "person_alice";
const TEAM_AGENT = "agent_alicesteam";

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: TEAM_AGENT,
    name: "Alice's Team",
    owner_id: PERSON,
    hierarchy_level: "team",
    runtime_config: { type: "claude" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: "room_1",
    name: "Launch war room",
    owner_person_id: PERSON,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeMessage(overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: "rmsg_1",
    room_id: "room_1",
    kind: "human",
    sender_person_id: PERSON,
    content: "hello room",
    created_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  };
}

function fakeMember(overrides: Partial<RoomMember> = {}): RoomMember {
  return {
    room_id: "room_1",
    kind: "person",
    subject_id: PERSON,
    joined_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_1",
    agent_id: TEAM_AGENT,
    type: "chat",
    status: "running",
    intent: "hi",
    created_at: new Date("2026-01-02T00:00:00Z"),
    updated_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  } as Session;
}

function fakeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
  return {
    id: "ev_1",
    session_id: "sess_1",
    kind: "tool_call",
    content: "bash ls",
    created_at: new Date("2026-01-02T00:01:00Z"),
    ...overrides,
  };
}

// ── Fake ports ───────────────────────────────────────────────────────────

function makeRoomRepo(): RoomRepository {
  return {
    create: vi.fn(async (input) => fakeRoom({ ...input })),
    findById: vi.fn(async () => fakeRoom()),
    listForPerson: vi.fn(async () => []),
    addPersonMember: vi.fn(async () => {}),
    addAgentMember: vi.fn(async () => {}),
    listMembers: vi.fn(async () => []),
    listMemberPersonIds: vi.fn(async () => []),
    listMemberAgentIds: vi.fn(async () => []),
    isMember: vi.fn(async () => true),
    areAgentsCoMembers: vi.fn(async () => true),
    appendMessage: vi.fn(async (input) => fakeMessage({ ...input })),
    listMessages: vi.fn(async () => []),
  } as unknown as RoomRepository;
}

function makeAgentRepo(): AgentRepository {
  return {
    findById: vi.fn(async () => fakeAgent()),
    findTopLevelForOwner: vi.fn(async () => fakeAgent()),
    findSubordinates: vi.fn(async () => []),
  } as unknown as AgentRepository;
}

function makePersonRepo(): PersonRepository {
  return {
    findById: vi.fn(async (id: string) => ({ id, name: "Alice", email: "alice@x.dev" })),
    findByEmail: vi.fn(async () => undefined),
  } as unknown as PersonRepository;
}

function makeSessionRepo(): SessionRepository {
  return {
    listRunningInRoom: vi.fn(async () => []),
    findLatestForAgentInRoom: vi.fn(async () => undefined),
  } as unknown as SessionRepository;
}

function makeSessionEventRepo(): SessionEventRepository {
  return {
    append: vi.fn(),
    listBySession: vi.fn(async () => []),
  } as unknown as SessionEventRepository;
}

interface Ports {
  roomRepo: RoomRepository;
  agentRepo: AgentRepository;
  personRepo: PersonRepository;
  sessionRepo: SessionRepository;
  sessionEventRepo: SessionEventRepository;
  workspaceManager: WorkspaceManager;
  runtimeRegistry: RuntimeRegistry;
}

function makePorts(overrides: Partial<Ports> = {}): Ports {
  return {
    roomRepo: makeRoomRepo(),
    agentRepo: makeAgentRepo(),
    personRepo: makePersonRepo(),
    sessionRepo: makeSessionRepo(),
    sessionEventRepo: makeSessionEventRepo(),
    workspaceManager: {
      ensureWorkspace: vi.fn(async () => ({ path: "/ws/agent", agentId: TEAM_AGENT })),
      removeWorkspace: vi.fn(),
    } as unknown as WorkspaceManager,
    runtimeRegistry: { claude: {} } as unknown as RuntimeRegistry,
    ...overrides,
  };
}

/**
 * Stand-in for `createAuthMiddleware`. The real one resolves a bv_ token
 * against Postgres; these tests only care about the caller shape
 * `requireHuman` gates on, so the source is set per-app.
 */
function stubAuth(source: "human" | "agent" | "none") {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (source === "human") {
      req.caller = {
        source: "human",
        agentId: TEAM_AGENT,
        hierarchyLevel: "team",
        personId: PERSON,
      };
    } else if (source === "agent") {
      req.caller = { source: "agent", agentId: TEAM_AGENT, hierarchyLevel: "ic" };
    }
    next();
  };
}

function makeApp(ports: Ports, source: "human" | "agent" | "none" = "human") {
  const app = express();
  app.use(json());
  app.use(
    "/room",
    createRoomRouter({
      authMiddleware: stubAuth(source),
      ...ports,
      makeMemoryAgent: () => ({}) as MemoryAgent,
    }),
  );
  return app;
}

beforeEach(() => {
  sessionRun.mockReset();
  sessionRun.mockResolvedValue(
    fakeSession({ status: "succeeded", result_summary: "done" }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── POST /room ───────────────────────────────────────────────────────────

describe("POST /room", () => {
  it("creates a room, adds the caller and their team agent", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports)).post("/room").send({ name: "  Launch  " });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.room.name).toBe("Launch");
    expect(ports.roomRepo.addPersonMember).toHaveBeenCalledWith(res.body.room.id, PERSON);
    expect(ports.roomRepo.addAgentMember).toHaveBeenCalledWith(res.body.room.id, TEAM_AGENT);
  });

  it("still creates the room when the caller has no team agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).post("/room").send({ name: "Solo" });

    expect(res.status).toBe(200);
    expect(ports.roomRepo.addAgentMember).not.toHaveBeenCalled();
  });

  it.each([{}, { name: "   " }, { name: 42 }])("400s a nameless body %j", async (body) => {
    const ports = makePorts();
    const res = await request(makeApp(ports)).post("/room").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("name_required");
    expect(ports.roomRepo.create).not.toHaveBeenCalled();
  });

  it("403s an agent caller", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports, "agent")).post("/room").send({ name: "x" });

    expect(res.status).toBe(403);
    expect(ports.roomRepo.create).not.toHaveBeenCalled();
  });

  it("403s an unauthenticated caller", async () => {
    const res = await request(makeApp(makePorts(), "none")).post("/room").send({ name: "x" });

    expect(res.status).toBe(403);
  });

  it("500s when the repo throws", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.create).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(ports)).post("/room").send({ name: "x" });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: "internal_error", message: "pg down" });
  });
});

// ── GET /room ────────────────────────────────────────────────────────────

describe("GET /room", () => {
  it("lists the caller's rooms", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listForPerson).mockResolvedValue([fakeRoom()]);

    const res = await request(makeApp(ports)).get("/room");

    expect(res.status).toBe(200);
    expect(res.body.rooms).toHaveLength(1);
    expect(ports.roomRepo.listForPerson).toHaveBeenCalledWith(PERSON);
  });

  it("500s when the repo throws", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listForPerson).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(ports)).get("/room");

    expect(res.status).toBe(500);
  });

  it("403s an agent caller", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports, "agent")).get("/room");

    expect(res.status).toBe(403);
    expect(ports.roomRepo.listForPerson).not.toHaveBeenCalled();
  });
});

// ── GET /room/:id ────────────────────────────────────────────────────────

describe("GET /room/:id", () => {
  it("404s a non-member", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.isMember).mockResolvedValue(false);

    const res = await request(makeApp(ports)).get("/room/room_1");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("room_not_found");
    expect(ports.roomRepo.listMembers).not.toHaveBeenCalled();
  });

  it("404s when the room row is gone despite the membership row", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.findById).mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).get("/room/room_1");

    expect(res.status).toBe(404);
  });

  it("hydrates members, messages and typing indicators", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listMembers).mockResolvedValue([
      fakeMember(),
      fakeMember({ kind: "agent", subject_id: TEAM_AGENT }),
      // A member row whose subject row was deleted — filtered out, not crashed on.
      fakeMember({ kind: "agent", subject_id: "agent_ghost" }),
    ]);
    vi.mocked(ports.agentRepo.findById).mockImplementation(async (id: string) =>
      id === TEAM_AGENT ? fakeAgent() : undefined,
    );
    vi.mocked(ports.roomRepo.listMessages).mockResolvedValue([
      fakeMessage(),
      fakeMessage({
        id: "rmsg_2",
        kind: "agent",
        sender_person_id: undefined,
        sender_agent_id: TEAM_AGENT,
        session_id: "sess_1",
        content: "shipping it\n<suggest_action>Ship now</suggest_action>",
      }),
    ]);
    vi.mocked(ports.sessionRepo.listRunningInRoom).mockResolvedValue([
      fakeSession({ started_at: new Date("2026-01-02T00:00:30Z") }),
      // Running session for an agent that isn't a room member — excluded.
      fakeSession({ id: "sess_other", agent_id: "agent_stranger" }),
    ]);
    vi.mocked(ports.sessionEventRepo.listBySession).mockResolvedValue([
      fakeEvent({ tool_name: "Bash" }),
      fakeEvent({ id: "ev_2", content: "x".repeat(500) }),
    ]);

    const res = await request(makeApp(ports)).get("/room/room_1");

    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([
      { kind: "person", id: PERSON, name: "Alice", email: "alice@x.dev" },
      {
        kind: "agent",
        id: TEAM_AGENT,
        name: "Alice's Team",
        hierarchy: "team",
        owner_person_id: PERSON,
      },
    ]);
    // Directives are stripped from the visible content and surfaced as siblings.
    expect(res.body.messages[1].content).toBe("shipping it");
    expect(res.body.messages[1].suggested_actions).toEqual([{ label: "Ship now" }]);
    expect(res.body.messages[1].session_id).toBe("sess_1");
    expect(res.body.typing).toHaveLength(1);
    expect(res.body.typing[0]).toMatchObject({
      session_id: "sess_1",
      agent_id: TEAM_AGENT,
      agent_name: "Alice's Team",
      started_at: "2026-01-02T00:00:30.000Z",
      total_steps: 2,
    });
    expect(res.body.typing[0].recent_steps[0]).toEqual({
      event_id: "ev_1",
      kind: "tool_call",
      tool_name: "Bash",
      content: "bash ls",
    });
    // Event content is truncated so a giant tool result can't bloat the poll.
    expect(res.body.typing[0].recent_steps[1].content).toHaveLength(200);
    expect(res.body.typing[0].recent_steps[1].tool_name).toBeNull();
  });

  it("falls back to created_at when a running session has no started_at", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listMembers).mockResolvedValue([
      fakeMember({ kind: "agent", subject_id: TEAM_AGENT }),
    ]);
    vi.mocked(ports.sessionRepo.listRunningInRoom).mockResolvedValue([fakeSession()]);

    const res = await request(makeApp(ports)).get("/room/room_1");

    expect(res.body.typing[0].started_at).toBe("2026-01-02T00:00:00.000Z");
    expect(res.body.typing[0].total_steps).toBe(0);
  });

  it("500s when a hydration query throws", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listMembers).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(ports)).get("/room/room_1");

    expect(res.status).toBe(500);
  });
});

// ── POST /room/:id/join ──────────────────────────────────────────────────

describe("POST /room/:id/join", () => {
  it("adds the caller and their team agent — no prior membership needed", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports)).post("/room/room_1/join");

    expect(res.status).toBe(200);
    expect(ports.roomRepo.isMember).not.toHaveBeenCalled();
    expect(ports.roomRepo.addPersonMember).toHaveBeenCalledWith("room_1", PERSON);
    expect(ports.roomRepo.addAgentMember).toHaveBeenCalledWith("room_1", TEAM_AGENT);
  });

  it("joins a caller with no team agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).post("/room/room_1/join");

    expect(res.status).toBe(200);
    expect(ports.roomRepo.addAgentMember).not.toHaveBeenCalled();
  });

  it("404s an unknown room", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.findById).mockResolvedValue(undefined);

    const res = await request(makeApp(ports)).post("/room/room_x/join");

    expect(res.status).toBe(404);
    expect(ports.roomRepo.addPersonMember).not.toHaveBeenCalled();
  });

  it("500s when the join write throws", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.addPersonMember).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(ports)).post("/room/room_1/join");

    expect(res.status).toBe(500);
  });

  it("403s an agent caller", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports, "agent")).post("/room/room_1/join");

    expect(res.status).toBe(403);
  });
});

// ── POST /room/:id/invite ────────────────────────────────────────────────

describe("POST /room/:id/invite", () => {
  it("invites an existing person plus their team agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.personRepo.findByEmail).mockResolvedValue({
      id: "person_bob",
      name: "Bob",
      email: "bob@x.dev",
    } as never);
    vi.mocked(ports.agentRepo.findTopLevelForOwner).mockResolvedValue(
      fakeAgent({ id: "agent_bobsteam", owner_id: "person_bob" }),
    );

    const res = await request(makeApp(ports))
      .post("/room/room_1/invite")
      .send({ email: "  BOB@X.dev  " });

    expect(res.status).toBe(200);
    // Email is normalized before the lookup, so casing/whitespace in the
    // invite box can't produce a spurious person_not_found.
    expect(ports.personRepo.findByEmail).toHaveBeenCalledWith("bob@x.dev");
    expect(res.body.invited).toEqual({
      person_id: "person_bob",
      name: "Bob",
      email: "bob@x.dev",
    });
    expect(ports.roomRepo.addAgentMember).toHaveBeenCalledWith("room_1", "agent_bobsteam");
  });

  it("invites a person who has no team agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.personRepo.findByEmail).mockResolvedValue({
      id: "person_bob",
      name: "Bob",
      email: "bob@x.dev",
    } as never);
    vi.mocked(ports.agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);

    const res = await request(makeApp(ports))
      .post("/room/room_1/invite")
      .send({ email: "bob@x.dev" });

    expect(res.status).toBe(200);
    expect(ports.roomRepo.addAgentMember).not.toHaveBeenCalled();
  });

  it("404s a non-member inviter", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.isMember).mockResolvedValue(false);

    const res = await request(makeApp(ports))
      .post("/room/room_1/invite")
      .send({ email: "bob@x.dev" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("room_not_found");
    expect(ports.personRepo.findByEmail).not.toHaveBeenCalled();
  });

  it.each([{}, { email: "  " }, { email: 7 }])("400s a body without an email %j", async (body) => {
    const ports = makePorts();
    const res = await request(makeApp(ports)).post("/room/room_1/invite").send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("email_required");
  });

  it("404s an email with no account", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports))
      .post("/room/room_1/invite")
      .send({ email: "nobody@x.dev" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("person_not_found");
    expect(res.body.message).toContain("nobody@x.dev");
    expect(ports.roomRepo.addPersonMember).not.toHaveBeenCalled();
  });

  it("500s when the lookup throws", async () => {
    const ports = makePorts();
    vi.mocked(ports.personRepo.findByEmail).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(ports))
      .post("/room/room_1/invite")
      .send({ email: "bob@x.dev" });

    expect(res.status).toBe(500);
  });

  it("403s an agent caller", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports, "agent"))
      .post("/room/room_1/invite")
      .send({ email: "bob@x.dev" });

    expect(res.status).toBe(403);
  });
});

// ── POST /room/:id/message ───────────────────────────────────────────────

describe("POST /room/:id/message", () => {
  it("404s a non-member", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.isMember).mockResolvedValue(false);

    const res = await request(makeApp(ports))
      .post("/room/room_1/message")
      .send({ content: "hi" });

    expect(res.status).toBe(404);
    expect(ports.roomRepo.appendMessage).not.toHaveBeenCalled();
  });

  it.each([{}, { content: "   " }, { content: null }])(
    "400s a body without content %j",
    async (body) => {
      const ports = makePorts();
      const res = await request(makeApp(ports)).post("/room/room_1/message").send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("content_required");
      expect(ports.roomRepo.appendMessage).not.toHaveBeenCalled();
    },
  );

  it("persists a pure human turn and invokes nobody", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listMemberAgentIds).mockResolvedValue([TEAM_AGENT]);

    const res = await request(makeApp(ports))
      .post("/room/room_1/message")
      .send({ content: "  standup at 10  " });

    expect(res.status).toBe(200);
    expect(res.body.message.content).toBe("standup at 10");
    expect(res.body.message.sender_person_id).toBe(PERSON);
    expect(res.body.invoked_agents).toEqual([]);
    expect(res.body.invoked_reason).toBe("none");
    expect(sessionRun).not.toHaveBeenCalled();
  });

  it("responds before the agent run finishes, then persists the reply", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listMemberAgentIds).mockResolvedValue([TEAM_AGENT]);
    sessionRun.mockResolvedValue(
      fakeSession({ id: "sess_9", status: "succeeded", result_summary: "on it" }),
    );

    const res = await request(makeApp(ports))
      .post("/room/room_1/message")
      .send({ content: `@${TEAM_AGENT} status?` });

    expect(res.status).toBe(200);
    expect(res.body.invoked_agents).toEqual([{ id: TEAM_AGENT, name: "Alice's Team" }]);
    expect(res.body.invoked_reason).toBe("mention");

    await vi.waitFor(() =>
      expect(ports.roomRepo.appendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "agent",
          sender_agent_id: TEAM_AGENT,
          content: "on it",
          session_id: "sess_9",
        }),
      ),
    );
  });

  it("500s when persisting the human turn throws", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.appendMessage).mockRejectedValue(new Error("pg down"));

    const res = await request(makeApp(ports))
      .post("/room/room_1/message")
      .send({ content: "hi" });

    expect(res.status).toBe(500);
  });

  it("403s an agent caller", async () => {
    const ports = makePorts();
    const res = await request(makeApp(ports, "agent"))
      .post("/room/room_1/message")
      .send({ content: "hi" });

    expect(res.status).toBe(403);
  });
});

// ── Background agent run ─────────────────────────────────────────────────
//
// `runMentionedAgents` is fire-and-forget, so each test posts a mention
// and then waits on the agent-kind `appendMessage` that closes the turn.

/** The agent-kind message the background run appends, once it lands. */
async function agentReply(ports: Ports): Promise<Record<string, unknown>> {
  const calls = vi.mocked(ports.roomRepo.appendMessage).mock.calls;
  let found: Record<string, unknown> | undefined;
  await vi.waitFor(() => {
    found = calls.map((c) => c[0] as Record<string, unknown>).find((m) => m.kind === "agent");
    expect(found).toBeDefined();
  });
  return found!;
}

async function postMention(ports: Ports, content = `@${TEAM_AGENT} status?`) {
  vi.mocked(ports.roomRepo.listMemberAgentIds).mockResolvedValue([TEAM_AGENT]);
  await request(makeApp(ports)).post("/room/room_1/message").send({ content });
}

describe("runMentionedAgents", () => {
  it("inlines the room transcript, member list and directives into the intent", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listMembers).mockResolvedValue([
      fakeMember(),
      fakeMember({ kind: "agent", subject_id: TEAM_AGENT }),
    ]);
    vi.mocked(ports.roomRepo.listMessages).mockResolvedValue([
      fakeMessage({ content: "kickoff" }),
      fakeMessage({
        id: "rmsg_2",
        kind: "agent",
        sender_agent_id: TEAM_AGENT,
        content: "ack",
      }),
      // The triggering message is already persisted, so it must be
      // trimmed off the history slice or the agent sees it twice.
      fakeMessage({ id: "rmsg_3", content: `@${TEAM_AGENT} status?` }),
    ]);
    vi.mocked(ports.agentRepo.findSubordinates).mockResolvedValue([
      fakeAgent({ id: "agent_ic", name: "Backend IC", hierarchy_level: "ic" }),
    ]);

    await postMention(ports);
    await agentReply(ports);

    const arg = sessionRun.mock.calls[0]![0];
    expect(arg.agentId).toBe(TEAM_AGENT);
    expect(arg.type).toBe("chat");
    expect(arg.roomId).toBe("room_1");
    expect(arg.workspace).toEqual({ path: "/ws/agent", agentId: TEAM_AGENT });
    expect(arg.intent).toContain('<room name="Launch war room" id="room_1">');
    expect(arg.intent).toContain(`- Alice's Team (agent, ${TEAM_AGENT}) [you]`);
    expect(arg.intent).toContain("Alice: kickoff");
    expect(arg.intent).toContain(`Alice's Team (${TEAM_AGENT}): ack`);
    // Trigger appears once — in the "latest message" block, not the history.
    expect(arg.intent.match(/status\?/g)).toHaveLength(1);
    // A team agent gets room directives AND the routing rubric.
    expect(arg.extraSystemPromptAppend).toContain("SHARED ROOM");
    expect(arg.extraSystemPromptAppend).toContain("Backend IC");
  });

  it("omits the routing directive for an IC agent", async () => {
    const ports = makePorts();
    vi.mocked(ports.agentRepo.findById).mockResolvedValue(
      fakeAgent({ hierarchy_level: "ic" }),
    );

    await postMention(ports);
    await agentReply(ports);

    expect(ports.agentRepo.findSubordinates).not.toHaveBeenCalled();
    const arg = sessionRun.mock.calls[0]![0];
    expect(arg.extraSystemPromptAppend).toContain("SHARED ROOM");
    expect(arg.extraSystemPromptAppend).not.toContain("<team_agent_routing>");
  });

  it("resumes the agent's prior session in this room", async () => {
    const ports = makePorts();
    vi.mocked(ports.sessionRepo.findLatestForAgentInRoom).mockResolvedValue(
      fakeSession({ id: "sess_prior" }),
    );

    await postMention(ports);
    await agentReply(ports);

    expect(sessionRun.mock.calls[0]![0].priorSessionId).toBe("sess_prior");
  });

  it("starts cold when the agent has no prior session in the room", async () => {
    const ports = makePorts();
    await postMention(ports);
    await agentReply(ports);

    expect(sessionRun.mock.calls[0]![0]).not.toHaveProperty("priorSessionId");
  });

  it("falls back to the raw trigger when the room row vanishes mid-turn", async () => {
    const ports = makePorts();
    // isMember passes, but the room is deleted before buildRoomIntent reads it.
    vi.mocked(ports.roomRepo.findById).mockResolvedValue(undefined);

    await postMention(ports);
    await agentReply(ports);

    expect(sessionRun.mock.calls[0]![0].intent).toBe(`@${TEAM_AGENT} status?`);
  });

  it("truncates an overlong history turn", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listMessages).mockResolvedValue([
      fakeMessage({ content: "z".repeat(2000) }),
      fakeMessage({ id: "rmsg_2", content: "trigger" }),
    ]);

    await postMention(ports);
    await agentReply(ports);

    expect(sessionRun.mock.calls[0]![0].intent).toContain("z".repeat(799) + "…");
  });

  it("labels messages from unknown senders rather than crashing", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listMessages).mockResolvedValue([
      fakeMessage({ sender_person_id: "person_ghost" }),
      fakeMessage({ id: "rmsg_2", kind: "agent", sender_agent_id: "agent_ghost" }),
      fakeMessage({ id: "rmsg_3", kind: "agent", sender_agent_id: undefined }),
      fakeMessage({ id: "rmsg_4", content: "trigger" }),
    ]);
    vi.mocked(ports.personRepo.findById).mockResolvedValue(undefined as never);
    vi.mocked(ports.roomRepo.listMembers).mockResolvedValue([fakeMember()]);

    await postMention(ports);
    await agentReply(ports);

    const intent = sessionRun.mock.calls[0]![0].intent as string;
    expect(intent).toContain("human: hello room");
    expect(intent).toContain("agent: hello room");
    expect(intent).toContain("?: hello room");
    expect(intent).toContain("a human said:");
  });

  it("notes an empty room history explicitly", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listMessages).mockResolvedValue([fakeMessage()]);

    await postMention(ports);
    await agentReply(ports);

    expect(sessionRun.mock.calls[0]![0].intent).toContain("(none yet — this is the first turn)");
  });

  it("escapes a room name containing quotes", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.findById).mockResolvedValue(
      fakeRoom({ name: 'the "war" room' }),
    );

    await postMention(ports);
    await agentReply(ports);

    expect(sessionRun.mock.calls[0]![0].intent).toContain(
      '<room name="the &quot;war&quot; room"',
    );
  });

  it("posts a visible error when the agent's runtime isn't registered", async () => {
    const ports = makePorts({ runtimeRegistry: {} as RuntimeRegistry });

    await postMention(ports);
    const msg = await agentReply(ports);

    expect(msg.content).toBe("(error: runtime 'claude' not registered)");
    expect(sessionRun).not.toHaveBeenCalled();
  });

  it("maps a failed session through the chat failure mapper", async () => {
    const ports = makePorts();
    sessionRun.mockResolvedValue(
      fakeSession({ status: "failed", error: "disk full" }),
    );

    await postMention(ports);
    const msg = await agentReply(ports);

    // Not the raw "CLI exited with code N" — the room sees the same
    // mapped text the 1:1 chat surface shows.
    expect(msg.content).toBe("disk full");
  });

  it("posts an empty reply when a completed session has no summary", async () => {
    const ports = makePorts();
    sessionRun.mockResolvedValue(fakeSession({ status: "succeeded" }));

    await postMention(ports);
    const msg = await agentReply(ports);

    expect(msg.content).toBe("");
  });

  it("surfaces a thrown run as an agent-kind message", async () => {
    const ports = makePorts();
    sessionRun.mockRejectedValue(new Error("spawn EACCES"));

    await postMention(ports);
    const msg = await agentReply(ports);

    expect(msg.content).toBe("(error: spawn EACCES)");
  });

  it("swallows a failure to persist the failure notice", async () => {
    const ports = makePorts();
    sessionRun.mockRejectedValue(new Error("spawn EACCES"));
    vi.mocked(ports.roomRepo.appendMessage).mockImplementation(async (input) => {
      if (input.kind === "agent") throw new Error("pg down");
      return fakeMessage({ ...input });
    });

    // The turn still returns 200; the best-effort catch keeps the
    // fire-and-forget run from producing an unhandled rejection.
    await expect(postMention(ports)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled());
  });

  it("runs several mentioned agents sequentially", async () => {
    const ports = makePorts();
    const second = fakeAgent({ id: "agent_bobsteam", name: "Bob's Team" });
    vi.mocked(ports.roomRepo.listMemberAgentIds).mockResolvedValue([
      TEAM_AGENT,
      "agent_bobsteam",
    ]);
    vi.mocked(ports.agentRepo.findById).mockImplementation(async (id: string) =>
      id === TEAM_AGENT ? fakeAgent() : second,
    );

    await request(makeApp(ports))
      .post("/room/room_1/message")
      .send({ content: `@${TEAM_AGENT} and @bobsteam — sync up?` });

    await vi.waitFor(() => expect(sessionRun).toHaveBeenCalledTimes(2));
    expect(sessionRun.mock.calls.map((c) => c[0].agentId)).toEqual([
      TEAM_AGENT,
      "agent_bobsteam",
    ]);
  });

  it("skips member ids whose agent row is gone", async () => {
    const ports = makePorts();
    vi.mocked(ports.roomRepo.listMemberAgentIds).mockResolvedValue([TEAM_AGENT, "agent_ghost"]);
    vi.mocked(ports.agentRepo.findById).mockImplementation(async (id: string) =>
      id === TEAM_AGENT ? fakeAgent() : undefined,
    );

    const res = await request(makeApp(ports))
      .post("/room/room_1/message")
      .send({ content: "team, status?" });

    expect(res.body.invoked_agents).toEqual([{ id: TEAM_AGENT, name: "Alice's Team" }]);
  });
});

// ── resolveAddressees ────────────────────────────────────────────────────

describe("resolveAddressees", () => {
  const alice = { id: "agent_alicesteam", name: "Alice's Team" };
  const bob = { id: "agent_bobsteam", name: "Bob's Team" };
  const members = [alice, bob];

  it.each([
    ["full id", "@agent_bobsteam ping"],
    ["short id", "@bobsteam ping"],
    ["normalized name", "@bobsteam ping"],
    ["mixed case", "@AGENT_BOBSTEAM ping"],
  ])("routes an @mention by %s", (_label, content) => {
    expect(resolveAddressees(content, members, alice.id)).toEqual({
      agents: [bob],
      reason: "mention",
    });
  });

  it("dedupes repeated mentions of the same agent, preserving order", () => {
    const out = resolveAddressees("@bobsteam @alicesteam @bobsteam", members, alice.id);

    expect(out.agents).toEqual([bob, alice]);
    expect(out.reason).toBe("mention");
  });

  it("ignores an @mention that matches no member", () => {
    expect(resolveAddressees("@nobody hi", members, undefined)).toEqual({
      agents: [],
      reason: "none",
    });
  });

  it("prefers a named vocative over the generic team keyword", () => {
    // "team, ..." would otherwise route to the speaker's own agent; the
    // more specific "Bob's team" in the vocative wins.
    expect(resolveAddressees("Bob's team, what's the ETA?", members, alice.id)).toEqual({
      agents: [bob],
      reason: "name",
    });
  });

  it("accepts a single-word first-name vocative", () => {
    expect(resolveAddressees("bob: ship it", members, alice.id)).toEqual({
      agents: [bob],
      reason: "name",
    });
  });

  it("does not first-name-match a multi-word vocative", () => {
    expect(resolveAddressees("hey there people, hi", members, undefined).agents).toEqual([]);
  });

  it("routes a bare team vocative to the speaker's own agent", () => {
    expect(resolveAddressees("team, status?", members, alice.id)).toEqual({
      agents: [alice],
      reason: "team-default",
    });
  });

  it("stays silent on a team vocative when the speaker has no agent", () => {
    expect(resolveAddressees("team, status?", members, undefined).reason).toBe("none");
  });

  it("stays silent when the speaker's agent isn't a room member", () => {
    expect(resolveAddressees("team, status?", members, "agent_elsewhere").reason).toBe("none");
  });

  it("matches an agent name anywhere in the message", () => {
    expect(resolveAddressees("what does Bob's Team think?", members, alice.id)).toEqual({
      agents: [bob],
      reason: "name",
    });
  });

  it("matches the team keyword anywhere when nobody is named", () => {
    expect(resolveAddressees("what do the agents think?", members, alice.id)).toEqual({
      agents: [alice],
      reason: "team-default",
    });
  });

  it("ignores agent names shorter than four characters", () => {
    const tiny = [{ id: "agent_x", name: "Ax" }];
    expect(resolveAddressees("is Ax around", tiny, undefined).agents).toEqual([]);
  });

  it("returns nobody for pure human chat", () => {
    expect(resolveAddressees("lunch at noon?", members, alice.id)).toEqual({
      agents: [],
      reason: "none",
    });
  });

  it("ignores a vocative longer than 80 characters", () => {
    const content = `${"long ".repeat(20)}team, hi`;
    expect(resolveAddressees(content, members, alice.id).reason).toBe("team-default");
  });
});
