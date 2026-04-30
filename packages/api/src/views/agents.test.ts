import { describe, it, expect, vi } from "vitest";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { listAgents, getAgent } from "./agents.js";

function makePool(responses: unknown[][]) {
  let i = 0;
  const query = vi.fn(async () => ({ rows: responses[i++] ?? [] }));
  return { query: query as unknown as Pool["query"] } as unknown as Pool;
}

describe("listAgents", () => {
  it("maps rows into AgentDisplay with hierarchy + sessions/facts counts", async () => {
    const pool = makePool([
      [
        {
          id: "agt_org",
          name: "Atlas",
          owner_id: "per_w",
          parent_agent_id: null,
          hierarchy_level: "org",
          review_policy: null,
          runtime_config: { type: "claude-code", model: "opus" },
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
    expect(agents[0]?.runtime).toBe("opus");
  });
});

describe("getAgent", () => {
  it("returns undefined when missing", async () => {
    const pool = makePool([[], [], [], []]);
    expect(await getAgent(pool, "agt_missing")).toBeUndefined();
  });

  it("aggregates blocks, recent sessions, and mesh hints when present", async () => {
    const pool = makePool([
      [
        {
          id: "agt_team",
          name: "Beta",
          owner_id: "per_w",
          parent_agent_id: "agt_org",
          hierarchy_level: "team",
          review_policy: "auto_done",
          runtime_config: { type: "claude-code", model: "sonnet" },
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
          id: "neg_1",
          target_name: "Charlie",
          created_at: new Date(),
          opening_message: "Can you review the schema?",
        },
      ],
    ]);
    const detail = await getAgent(pool, "agt_team");
    expect(detail?.display_name).toBe("Beta");
    expect(detail?.metrics.sessions).toBe(3);
    expect(detail?.metrics.facts).toBe(7);
    expect(detail?.core_blocks).toHaveLength(1);
    expect(detail?.core_blocks[0]?.char_count).toBe(3);
    expect(detail?.recent_sessions).toHaveLength(1);
    expect(detail?.recent_sessions[0]?.short_id).toBe("qwerty");
    expect(detail?.recent_sessions[0]?.title).toBe("Bill rewrite");
    expect(detail?.outgoing_mesh_hints).toHaveLength(1);
    expect(detail?.outgoing_mesh_hints[0]?.target).toBe("Charlie");
  });
});
