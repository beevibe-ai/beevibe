import { describe, it, expect } from "vitest";
import { listAgents, getAgent } from "./agents.js";
import { makeMockPool } from "./test-helpers.js";

describe("listAgents", () => {
  it("maps rows into AgentDisplay with hierarchy + sessions/facts counts", async () => {
    const pool = makeMockPool([
      [
        {
          id: "agt_org",
          name: "Atlas",
          owner_id: "per_w",
          owner_label: "Wendy",
          parent_agent_id: null,
          hierarchy_level: "org",
          review_policy: null,
          runtime_config: { type: "claude", model: "opus" },
          created_at: new Date(),
          updated_at: new Date(),
          sessions_count: 12,
          facts_learned: 4,
        },
      ],
    ]);
    const agents = await listAgents(pool);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.display_name).toBe("Atlas");
    expect(agents[0]?.hierarchy).toBe("org");
    expect(agents[0]?.sessions_count).toBe(12);
    expect(agents[0]?.facts_learned).toBe(4);
    expect(agents[0]?.runtime).toBe("claude");
    expect(agents[0]?.model).toBe("opus");
    expect(agents[0]?.owner_label).toBe("Wendy");
  });

  it("returns undefined model when runtime_config has no model set", async () => {
    const pool = makeMockPool([
      [
        {
          id: "agt_x",
          name: "NoModel",
          owner_id: "per_w",
          owner_label: "Wendy",
          parent_agent_id: null,
          hierarchy_level: "ic",
          review_policy: null,
          runtime_config: { type: "claude" },
          created_at: new Date(),
          updated_at: new Date(),
          sessions_count: 0,
          facts_learned: 0,
        },
      ],
    ]);
    const agents = await listAgents(pool);
    expect(agents[0]?.runtime).toBe("claude");
    expect(agents[0]?.model).toBeUndefined();
  });
});

describe("getAgent", () => {
  it("returns undefined when missing", async () => {
    // getAgent fires 6 queries in parallel — agent, blocks, recent
    // sessions, recent chat threads, mesh hints, delta metrics.
    const pool = makeMockPool([[], [], [], [], [], []]);
    expect(await getAgent(pool, "agt_missing")).toBeUndefined();
  });

  it("aggregates blocks, recent sessions, chat threads, mesh hints, and delta metrics", async () => {
    const lastTurnAt = new Date("2026-05-30T10:00:00Z");
    const pool = makeMockPool([
      [
        {
          id: "agt_team",
          name: "Beta",
          owner_id: "per_w",
          owner_label: "Wendy",
          parent_agent_id: "agt_org",
          hierarchy_level: "team",
          review_policy: "auto_done",
          runtime_config: { type: "claude", model: "sonnet" },
          created_at: new Date(),
          updated_at: new Date(),
          sessions_count: 3,
          facts_learned: 7,
        },
      ],
      [
        {
          id: "blk_1",
          agent_id: "agt_team",
          block_name: "persona",
          content: "abc",
          char_limit: 1000,
          is_system: true,
          updated_at: new Date(),
        },
      ],
      [
        {
          id: "sess_qwerty12",
          intent: "Refactor billing",
          status: "running",
          task_id: "task_1",
          created_at: new Date(),
          task_title: "Bill rewrite",
        },
      ],
      [
        {
          conversation_id: "sess_chat0001",
          turn_count: 4,
          last_at: lastTurnAt,
          intent_first: "hey what's the status of the migration?",
          last_status: "succeeded",
        },
      ],
      [
        {
          id: "neg_1",
          target_name: "Charlie",
          created_at: new Date(),
          opening_message: "Can you review the schema?",
        },
      ],
      [{ sessions_change: 5, merges: 2, promoted: 4 }],
    ]);
    const detail = await getAgent(pool, "agt_team");
    expect(detail?.display_name).toBe("Beta");
    expect(detail?.metrics.sessions).toBe(3);
    expect(detail?.metrics.facts).toBe(7);
    expect(detail?.metrics.sessions_change).toBe(5);
    expect(detail?.metrics.merges).toBe(2);
    expect(detail?.metrics.promoted).toBe(4);
    expect(detail?.core_blocks).toHaveLength(1);
    expect(detail?.core_blocks[0]?.char_count).toBe(3);
    expect(detail?.recent_sessions).toHaveLength(1);
    expect(detail?.recent_sessions[0]?.short_id).toBe("qwerty");
    expect(detail?.recent_sessions[0]?.title).toBe("Bill rewrite");
    expect(detail?.recent_chat_threads).toHaveLength(1);
    expect(detail?.recent_chat_threads[0]?.conversation_id).toBe("sess_chat0001");
    expect(detail?.recent_chat_threads[0]?.turn_count).toBe(4);
    expect(detail?.recent_chat_threads[0]?.title).toBe(
      "hey what's the status of the migration?",
    );
    expect(detail?.recent_chat_threads[0]?.last_status).toBe("succeeded");
    expect(detail?.outgoing_mesh_hints).toHaveLength(1);
    expect(detail?.outgoing_mesh_hints[0]?.target).toBe("Charlie");
    expect(detail?.owner_label).toBe("Wendy");
  });

  it("truncates the chat thread title to 80 chars", async () => {
    const longIntent = "x".repeat(200);
    const pool = makeMockPool([
      [
        {
          id: "agt_x",
          name: "X",
          owner_id: "per_w",
          owner_label: "Wendy",
          parent_agent_id: null,
          hierarchy_level: "ic",
          review_policy: null,
          runtime_config: { type: "claude" },
          created_at: new Date(),
          updated_at: new Date(),
          sessions_count: 0,
          facts_learned: 0,
        },
      ],
      [],
      [],
      [
        {
          conversation_id: "sess_long",
          turn_count: 1,
          last_at: new Date(),
          intent_first: longIntent,
          last_status: "running",
        },
      ],
      [],
      [],
    ]);
    const detail = await getAgent(pool, "agt_x");
    expect(detail?.recent_chat_threads[0]?.title.length).toBe(80);
    expect(detail?.recent_chat_threads[0]?.title.endsWith("…")).toBe(true);
  });
});
