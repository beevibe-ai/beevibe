import { describe, it, expect, vi } from "vitest";
import type { Pool } from "@beevibe/core/adapters/postgres";
import { listMemoryFacts } from "./memory.js";

function makePool(rows: unknown[]) {
  const query = vi.fn(async () => ({ rows }));
  return {
    query: query as unknown as Pool["query"],
    _spy: query,
  } as unknown as Pool & { _spy: ReturnType<typeof vi.fn> };
}

describe("listMemoryFacts", () => {
  it("filters by owner and forwards null scope when not provided", async () => {
    const pool = makePool([]);
    await listMemoryFacts(pool, "per_w");
    expect((pool as unknown as { _spy: ReturnType<typeof vi.fn> })._spy).toHaveBeenCalledWith(
      expect.any(String),
      ["per_w", null],
    );
  });

  it("forwards scope when provided", async () => {
    const pool = makePool([]);
    await listMemoryFacts(pool, "per_w", { scope: "team" });
    expect((pool as unknown as { _spy: ReturnType<typeof vi.fn> })._spy).toHaveBeenCalledWith(
      expect.any(String),
      ["per_w", "team"],
    );
  });

  it("maps merge_origin from source_session_ids cardinality", async () => {
    const pool = makePool([
      {
        id: "fact_1",
        agent_id: "agt_a",
        scope: "ic",
        fact_type: "belief",
        content: "always run tests",
        source_session_ids: ["sess_1"],
        created_at: new Date(),
        agent_label: "Alice",
      },
      {
        id: "fact_2",
        agent_id: "agt_a",
        scope: "team",
        fact_type: "pattern",
        content: "PR template",
        source_session_ids: ["sess_1", "sess_2"],
        created_at: new Date(),
        agent_label: "Alice",
      },
    ]);
    const facts = await listMemoryFacts(pool, "per_w");
    expect(facts[0]?.merge_origin).toBe("single");
    expect(facts[0]?.source_session_count).toBe(1);
    expect(facts[1]?.merge_origin).toBe("merged");
    expect(facts[1]?.source_session_count).toBe(2);
    expect(facts[1]?.agent_label).toBe("Alice");
  });
});
