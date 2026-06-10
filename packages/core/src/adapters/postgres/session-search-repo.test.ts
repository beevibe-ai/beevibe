import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_CONFIG } from "../../domain/agent.js";
import {
  agentId,
  personId,
  sessionEventId,
  sessionId,
  taskId,
} from "../../domain/ids.js";
import {
  userMessageId,
} from "../../domain/session-search.js";
import type { SessionSearchScope } from "../../ports/session-search-repo.js";
import type { Pool } from "./client.js";
import { createTestPool, truncateAll } from "../../test-helpers.js";
import { PostgresAgentRepository } from "./agent-repo.js";
import { PostgresPersonRepository } from "./person-repo.js";
import { PostgresSessionEventRepository } from "./session-event-repo.js";
import { PostgresSessionRepository } from "./session-repo.js";
import { PostgresTaskRepository } from "./task-repo.js";
import { PostgresSessionSearchRepository } from "./session-search-repo.js";

describe("PostgresSessionSearchRepository", () => {
  let pool: Pool;
  let search: PostgresSessionSearchRepository;
  let sessions: PostgresSessionRepository;
  let events: PostgresSessionEventRepository;
  let agents: PostgresAgentRepository;
  let persons: PostgresPersonRepository;
  let tasks: PostgresTaskRepository;
  let owner: string;
  let aliceAgent: string;
  let bobAgent: string;

  beforeAll(() => {
    pool = createTestPool();
    search = new PostgresSessionSearchRepository(pool);
    sessions = new PostgresSessionRepository(pool);
    events = new PostgresSessionEventRepository(pool);
    agents = new PostgresAgentRepository(pool);
    persons = new PostgresPersonRepository(pool);
    tasks = new PostgresTaskRepository(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    const p = await persons.create({ id: personId(), name: "Owner" });
    owner = p.id;
    const a = await agents.create({
      id: agentId(),
      name: "Alice",
      owner_id: owner,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    aliceAgent = a.id;
    const b = await agents.create({
      id: agentId(),
      name: "Bob",
      owner_id: owner,
      hierarchy_level: "ic",
      runtime_config: DEFAULT_RUNTIME_CONFIG,
    });
    bobAgent = b.id;
  });

  // ── Fixtures ────────────────────────────────────────────────────────

  /**
   * Create a task session with intent + assistant events.
   * `assistantTurns` are appended as session_event kind='agent'.
   */
  async function seedTaskSession(opts: {
    agent: string;
    intent: string;
    assistantTurns: string[];
    status?: "succeeded" | "failed" | "running";
    gapMs?: number;
  }): Promise<{ sid: string; eventIds: string[] }> {
    const sid = sessionId();
    const t = await tasks.create({
      id: taskId(),
      title: "T",
      priority: "medium",
      creator_id: owner,
      creator_type: "person",
    });
    await sessions.create({
      id: sid,
      agent_id: opts.agent,
      task_id: t.id,
      type: "task",
      intent: opts.intent,
      status: opts.status ?? "succeeded",
    });
    const eventIds: string[] = [];
    for (const turn of opts.assistantTurns) {
      const ev = await events.append({
        id: sessionEventId(),
        session_id: sid,
        kind: "agent",
        content: turn,
        tool_name: undefined,
      });
      eventIds.push(ev.id);
      if (opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs));
    }
    return { sid, eventIds };
  }

  /**
   * Seed a multi-turn chat conversation. Each entry is one (user, assistant)
   * turn pair; each turn becomes its own chat session linked by
   * prior_session_id so the repo's auto-conversation_id resolution kicks in.
   * Returns the head session id (== conversation_id).
   */
  async function seedChatConversation(opts: {
    agent: string;
    turns: { user: string; assistant: string }[];
    gapMs?: number;
  }): Promise<{
    conversationId: string;
    sessionIds: string[];
    eventIds: string[];
  }> {
    const sessionIds: string[] = [];
    const eventIds: string[] = [];
    let prior: string | undefined;
    for (const turn of opts.turns) {
      const sid = sessionId();
      await sessions.create({
        id: sid,
        agent_id: opts.agent,
        type: "chat",
        intent: turn.user,
        prior_session_id: prior,
      });
      sessionIds.push(sid);
      const ev = await events.append({
        id: sessionEventId(),
        session_id: sid,
        kind: "agent",
        content: turn.assistant,
        tool_name: undefined,
      });
      eventIds.push(ev.id);
      prior = sid;
      if (opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs));
    }
    return { conversationId: sessionIds[0]!, sessionIds, eventIds };
  }

  const scope = (agentIds: string[], exclude: string[] = []): SessionSearchScope => ({
    agent_ids: agentIds,
    exclude_lineage_keys: exclude,
  });

  // ── Discover ────────────────────────────────────────────────────────

  it("discover: returns FTS hits with snippet and bookends", async () => {
    const { sid } = await seedTaskSession({
      agent: aliceAgent,
      intent: "Investigate the auth middleware regression",
      assistantTurns: [
        "Looking at the auth flow now",
        "Found the bug in token verification",
        "Patched and tested",
      ],
    });

    const result = await search.discover(
      { kind: "discover", query: "auth middleware" },
      scope([aliceAgent]),
    );

    expect(result.kind).toBe("discover");
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit.session.session_id).toBe(sid);
    expect(hit.snippet).toMatch(/auth|middleware/i);
    // bookend_start contains the user intent + first assistant turn
    expect(hit.bookend_start[0]?.kind).toBe("user");
    expect(hit.bookend_start[0]?.content).toMatch(/auth middleware/i);
  });

  it("discover: dedupes hits by conversation lineage", async () => {
    // Two-turn chat — both turns mention 'docker', but should count as ONE
    // lineage in discover results.
    const { conversationId, sessionIds } = await seedChatConversation({
      agent: aliceAgent,
      turns: [
        { user: "How do I run docker locally?", assistant: "Try `docker compose up`" },
        { user: "Docker won't start", assistant: "Check the docker daemon" },
      ],
      gapMs: 5,
    });

    const result = await search.discover(
      { kind: "discover", query: "docker" },
      scope([aliceAgent]),
    );

    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    // Hit's matched session is one of the two turns; its conversation_id is
    // the conversation head. The dedupe-by-lineage check is implicit in
    // toHaveLength(1) above — without dedupe we'd see one hit per turn.
    expect(sessionIds).toContain(hit.session.session_id);
    expect(hit.session.conversation_id).toBe(conversationId);
  });

  it("discover: excludes the caller's active lineage", async () => {
    const { sid } = await seedTaskSession({
      agent: aliceAgent,
      intent: "Audit the password reset flow",
      assistantTurns: ["Checking the reset token TTL"],
    });

    const result = await search.discover(
      { kind: "discover", query: "password reset" },
      scope([aliceAgent], [sid]),
    );

    expect(result.hits).toHaveLength(0);
  });

  it("discover: filters by session_type and status", async () => {
    await seedTaskSession({
      agent: aliceAgent,
      intent: "Refactor billing logic",
      assistantTurns: ["Done — passes tests"],
      status: "succeeded",
    });
    await seedTaskSession({
      agent: aliceAgent,
      intent: "Refactor billing config",
      assistantTurns: ["Hit a runtime error, blocked"],
      status: "failed",
    });

    const onlyFailed = await search.discover(
      {
        kind: "discover",
        query: "billing",
        filters: { status: "failed" },
      },
      scope([aliceAgent]),
    );

    expect(onlyFailed.hits).toHaveLength(1);
    expect(onlyFailed.hits[0]!.session.status).toBe("failed");
  });

  it("discover: respects agent_id scope (owner boundary enforced upstream)", async () => {
    await seedTaskSession({
      agent: aliceAgent,
      intent: "Alice was investigating dependencies",
      assistantTurns: ["Checked pnpm-lock"],
    });
    await seedTaskSession({
      agent: bobAgent,
      intent: "Bob was investigating dependencies",
      assistantTurns: ["Checked pnpm-lock"],
    });

    const aliceOnly = await search.discover(
      { kind: "discover", query: "dependencies" },
      scope([aliceAgent]),
    );
    expect(aliceOnly.hits).toHaveLength(1);
    expect(aliceOnly.hits[0]!.session.agent_id).toBe(aliceAgent);
  });

  it("discover: returns empty when scope.agent_ids is empty", async () => {
    await seedTaskSession({
      agent: aliceAgent,
      intent: "Any topic at all",
      assistantTurns: ["doing the thing"],
    });
    const result = await search.discover(
      { kind: "discover", query: "topic" },
      scope([]),
    );
    expect(result.hits).toHaveLength(0);
  });

  // ── Scroll ──────────────────────────────────────────────────────────

  it("scroll: returns ±window around an anchor event id", async () => {
    const turns = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const { sid, eventIds } = await seedTaskSession({
      agent: aliceAgent,
      intent: "The greek letter walk",
      assistantTurns: turns,
      gapMs: 2,
    });
    const anchor = eventIds[2]!; // 'gamma'

    const result = await search.scroll(
      {
        kind: "scroll",
        session_id: sid,
        around_message_id: anchor,
        window: 2,
      },
      scope([aliceAgent]),
    );

    expect(result).not.toBeNull();
    expect(result!.kind).toBe("scroll");
    expect(result!.messages.find((m) => m.id === anchor)?.anchor).toBe(true);
    // ±2 around 'gamma' (idx ~3 with user-intent at idx 0): alpha,beta,gamma,delta,epsilon
    expect(result!.messages.length).toBeGreaterThanOrEqual(4);
  });

  it("scroll: rejects sessions outside the caller's scope", async () => {
    const { sid, eventIds } = await seedTaskSession({
      agent: bobAgent,
      intent: "Bob's private session",
      assistantTurns: ["Doing Bob things"],
    });

    const result = await search.scroll(
      {
        kind: "scroll",
        session_id: sid,
        around_message_id: eventIds[0]!,
      },
      scope([aliceAgent]),
    );

    expect(result).toBeNull();
  });

  it("scroll: rejects messages in the caller's active lineage", async () => {
    const { sid, eventIds } = await seedTaskSession({
      agent: aliceAgent,
      intent: "Currently active",
      assistantTurns: ["mid-conversation"],
    });

    const result = await search.scroll(
      {
        kind: "scroll",
        session_id: sid,
        around_message_id: eventIds[0]!,
      },
      scope([aliceAgent], [sid]),
    );

    expect(result).toBeNull();
  });

  it("scroll: returns null for unknown anchor id", async () => {
    const { sid } = await seedTaskSession({
      agent: aliceAgent,
      intent: "A real session",
      assistantTurns: ["one"],
    });
    const result = await search.scroll(
      {
        kind: "scroll",
        session_id: sid,
        around_message_id: "evt_nonexistent",
      },
      scope([aliceAgent]),
    );
    expect(result).toBeNull();
  });

  it("scroll: anchor at the synthesised user-turn id works", async () => {
    const { sid } = await seedTaskSession({
      agent: aliceAgent,
      intent: "First turn intent",
      assistantTurns: ["one", "two", "three"],
    });
    const result = await search.scroll(
      {
        kind: "scroll",
        session_id: sid,
        around_message_id: userMessageId(sid),
        window: 5,
      },
      scope([aliceAgent]),
    );
    expect(result).not.toBeNull();
    expect(result!.messages[0]?.kind).toBe("user");
    expect(result!.messages[0]?.anchor).toBe(true);
  });

  // ── Read ────────────────────────────────────────────────────────────

  it("read: returns the full session for a small task", async () => {
    const { sid } = await seedTaskSession({
      agent: aliceAgent,
      intent: "Tiny task",
      assistantTurns: ["one", "two"],
    });

    const result = await search.read({ kind: "read", session_id: sid }, scope([aliceAgent]));
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("read");
    expect(result!.truncated).toBe(false);
    // user + 2 assistant
    expect(result!.message_count).toBe(3);
  });

  it("read: returns the full chat conversation, not just one turn", async () => {
    const { conversationId } = await seedChatConversation({
      agent: aliceAgent,
      turns: [
        { user: "Hello", assistant: "Hi there" },
        { user: "How are you", assistant: "Fine thanks" },
        { user: "Bye", assistant: "Goodbye" },
      ],
      gapMs: 5,
    });

    const result = await search.read(
      { kind: "read", session_id: conversationId },
      scope([aliceAgent]),
    );
    expect(result).not.toBeNull();
    // 3 user + 3 assistant
    expect(result!.message_count).toBe(6);
    expect(result!.messages.filter((m) => m.kind === "user")).toHaveLength(3);
  });

  it("read: returns null for out-of-scope sessions", async () => {
    const { sid } = await seedTaskSession({
      agent: bobAgent,
      intent: "Bob's",
      assistantTurns: ["bob"],
    });
    const result = await search.read({ kind: "read", session_id: sid }, scope([aliceAgent]));
    expect(result).toBeNull();
  });

  // ── Browse ──────────────────────────────────────────────────────────

  it("browse: returns recent sessions in scope, deduped by lineage", async () => {
    await seedTaskSession({
      agent: aliceAgent,
      intent: "First task",
      assistantTurns: ["a"],
      gapMs: 5,
    });
    await seedChatConversation({
      agent: aliceAgent,
      turns: [
        { user: "chat 1 turn 1", assistant: "ok" },
        { user: "chat 1 turn 2", assistant: "ok" },
      ],
      gapMs: 5,
    });
    await seedTaskSession({
      agent: aliceAgent,
      intent: "Second task",
      assistantTurns: ["b"],
      gapMs: 5,
    });

    const result = await search.browse({ kind: "browse" }, scope([aliceAgent]));
    expect(result.kind).toBe("browse");
    // 2 tasks (each its own lineage) + 1 chat conversation
    expect(result.sessions).toHaveLength(3);
    // Each chat conversation appears once.
    const chatTurns = result.sessions.filter((s) => s.type === "chat");
    expect(chatTurns).toHaveLength(1);
  });

  it("browse: honors filters and excludes current lineage", async () => {
    const { sid: excl } = await seedTaskSession({
      agent: aliceAgent,
      intent: "Current session",
      assistantTurns: ["x"],
      gapMs: 5,
    });
    await seedTaskSession({
      agent: aliceAgent,
      intent: "Failed earlier",
      assistantTurns: ["err"],
      status: "failed",
      gapMs: 5,
    });
    await seedTaskSession({
      agent: aliceAgent,
      intent: "Succeeded earlier",
      assistantTurns: ["ok"],
      status: "succeeded",
      gapMs: 5,
    });

    const failed = await search.browse(
      { kind: "browse", filters: { status: "failed" } },
      scope([aliceAgent], [excl]),
    );
    expect(failed.sessions).toHaveLength(1);
    expect(failed.sessions[0]!.status).toBe("failed");
  });
});
