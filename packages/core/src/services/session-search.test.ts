import { describe, expect, it } from "vitest";
import type { Agent } from "../domain/agent.js";
import type { Session } from "../domain/session.js";
import type {
  BrowseRequest,
  BrowseResult,
  DiscoverRequest,
  DiscoverResult,
  ReadRequest,
  ReadResult,
  ScrollRequest,
  ScrollResult,
} from "../domain/session-search.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { SessionRepository } from "../ports/session-repo.js";
import type {
  SessionSearchRepository,
  SessionSearchScope,
} from "../ports/session-search-repo.js";
import {
  SessionSearchError,
  SessionSearchService,
} from "./session-search.js";

// ── Stub repos ───────────────────────────────────────────────────────

type DiscoverFn = (req: DiscoverRequest, scope: SessionSearchScope) => Promise<DiscoverResult>;
type ScrollFn = (req: ScrollRequest, scope: SessionSearchScope) => Promise<ScrollResult | null>;
type ReadFn = (req: ReadRequest, scope: SessionSearchScope) => Promise<ReadResult | null>;
type BrowseFn = (req: BrowseRequest, scope: SessionSearchScope) => Promise<BrowseResult>;

class StubSearchRepo implements SessionSearchRepository {
  lastScope: SessionSearchScope | null = null;
  discover: DiscoverFn;
  scroll: ScrollFn;
  read: ReadFn;
  browse: BrowseFn;

  constructor() {
    this.discover = async (req, scope) => {
      this.lastScope = scope;
      return { kind: "discover", query: req.query, hits: [], lineages_searched: 0 };
    };
    this.scroll = async (_req, scope) => {
      this.lastScope = scope;
      return null;
    };
    this.read = async (_req, scope) => {
      this.lastScope = scope;
      return null;
    };
    this.browse = async (_req, scope) => {
      this.lastScope = scope;
      return { kind: "browse", sessions: [] };
    };
  }
}

class StubAgentRepo {
  constructor(
    private subordinates: Record<string, string[]> = {},
    private descendants: Record<string, string[]> = {},
  ) {}
  async findSubordinates(parentAgentId: string): Promise<Agent[]> {
    const ids = this.subordinates[parentAgentId] ?? [];
    return ids.map((id) => ({ id }) as unknown as Agent);
  }
  async findDescendantIds(rootAgentId: string): Promise<string[]> {
    return this.descendants[rootAgentId] ?? [];
  }
}

class StubSessionRepo {
  constructor(private byId: Record<string, Session> = {}) {}
  async findById(id: string): Promise<Session | undefined> {
    return this.byId[id];
  }
}

function makeService(opts?: {
  subordinates?: Record<string, string[]>;
  descendants?: Record<string, string[]>;
  sessions?: Record<string, Session>;
}) {
  const repo = new StubSearchRepo();
  const agentRepo = new StubAgentRepo(opts?.subordinates, opts?.descendants);
  const sessionRepo = new StubSessionRepo(opts?.sessions);
  const service = new SessionSearchService(
    repo,
    agentRepo as unknown as AgentRepository,
    sessionRepo as unknown as SessionRepository,
  );
  return { service, repo };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess_caller",
    agent_id: "agent_caller",
    type: "chat",
    status: "running",
    intent: "x",
    created_at: new Date(),
    ...overrides,
  } as Session;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("SessionSearchService", () => {
  it("ic scope: only the caller's own agent_id", async () => {
    const { service, repo } = makeService({
      subordinates: { agent_a: ["agent_b"] },
      sessions: { sess_a: makeSession({ id: "sess_a", agent_id: "agent_a" }) },
    });

    await service.search(
      { kind: "discover", query: "anything" },
      { callerAgentId: "agent_a", hierarchyLevel: "ic", currentSessionId: "sess_a" },
    );

    expect(repo.lastScope?.agent_ids).toEqual(["agent_a"]);
  });

  it("team scope: caller + direct subordinates", async () => {
    const { service, repo } = makeService({
      subordinates: { agent_team: ["agent_ic1", "agent_ic2"] },
      sessions: {
        sess_a: makeSession({ id: "sess_a", agent_id: "agent_team" }),
      },
    });

    await service.search(
      { kind: "discover", query: "anything" },
      { callerAgentId: "agent_team", hierarchyLevel: "team", currentSessionId: "sess_a" },
    );

    expect(repo.lastScope?.agent_ids.sort()).toEqual(
      ["agent_team", "agent_ic1", "agent_ic2"].sort(),
    );
  });

  it("org scope: caller + recursive descendants", async () => {
    const { service, repo } = makeService({
      descendants: { agent_org: ["agent_team1", "agent_ic_a", "agent_ic_b"] },
      sessions: {
        sess_o: makeSession({ id: "sess_o", agent_id: "agent_org" }),
      },
    });

    await service.search(
      { kind: "discover", query: "anything" },
      { callerAgentId: "agent_org", hierarchyLevel: "org", currentSessionId: "sess_o" },
    );

    expect(repo.lastScope?.agent_ids.sort()).toEqual(
      ["agent_org", "agent_team1", "agent_ic_a", "agent_ic_b"].sort(),
    );
  });

  it("exclude_lineage_keys uses conversation_id for chats", async () => {
    const { service, repo } = makeService({
      sessions: {
        sess_t3: makeSession({
          id: "sess_t3",
          agent_id: "agent_a",
          type: "chat",
          conversation_id: "sess_t1",
        }),
      },
    });

    await service.search(
      { kind: "discover", query: "x" },
      { callerAgentId: "agent_a", hierarchyLevel: "ic", currentSessionId: "sess_t3" },
    );

    expect(repo.lastScope?.exclude_lineage_keys).toEqual(["sess_t1"]);
  });

  it("exclude_lineage_keys falls back to session id for non-chat", async () => {
    const { service, repo } = makeService({
      sessions: {
        sess_task: makeSession({
          id: "sess_task",
          agent_id: "agent_a",
          type: "task",
          conversation_id: undefined,
        }),
      },
    });

    await service.search(
      { kind: "browse" },
      { callerAgentId: "agent_a", hierarchyLevel: "ic", currentSessionId: "sess_task" },
    );

    expect(repo.lastScope?.exclude_lineage_keys).toEqual(["sess_task"]);
  });

  it("rejects filters.agent_id outside scope", async () => {
    const { service } = makeService({
      subordinates: { agent_team: ["agent_ic1"] },
      sessions: { sess_a: makeSession({ id: "sess_a", agent_id: "agent_team" }) },
    });

    await expect(
      service.search(
        {
          kind: "discover",
          query: "x",
          filters: { agent_id: "agent_outside_scope" },
        },
        { callerAgentId: "agent_team", hierarchyLevel: "team", currentSessionId: "sess_a" },
      ),
    ).rejects.toThrow(SessionSearchError);
  });

  it("accepts filters.agent_id inside scope", async () => {
    const { service, repo } = makeService({
      subordinates: { agent_team: ["agent_ic1"] },
      sessions: { sess_a: makeSession({ id: "sess_a", agent_id: "agent_team" }) },
    });

    await service.search(
      {
        kind: "discover",
        query: "x",
        filters: { agent_id: "agent_ic1" },
      },
      { callerAgentId: "agent_team", hierarchyLevel: "team", currentSessionId: "sess_a" },
    );

    expect(repo.lastScope?.agent_ids).toContain("agent_ic1");
  });

  it("requires query on discover", async () => {
    const { service } = makeService({
      sessions: { sess_a: makeSession({ id: "sess_a", agent_id: "agent_a" }) },
    });
    await expect(
      service.search(
        { kind: "discover", query: "" },
        { callerAgentId: "agent_a", hierarchyLevel: "ic", currentSessionId: "sess_a" },
      ),
    ).rejects.toThrow(SessionSearchError);
  });

  it("scroll requires both session_id and around_message_id", async () => {
    const { service } = makeService({
      sessions: { sess_a: makeSession({ id: "sess_a", agent_id: "agent_a" }) },
    });
    await expect(
      service.search(
        { kind: "scroll", session_id: "sess_x", around_message_id: "" },
        { callerAgentId: "agent_a", hierarchyLevel: "ic", currentSessionId: "sess_a" },
      ),
    ).rejects.toThrow(SessionSearchError);
  });
});
