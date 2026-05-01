import { describe, it, expect } from "vitest";
import { listMemoryFacts } from "./memory.js";
import { makeMockPool } from "./test-helpers.js";

describe("listMemoryFacts", () => {
  it("filters by owner and forwards null scope + default limit when not provided", async () => {
    const pool = makeMockPool([]);
    await listMemoryFacts(pool, "per_w");
    expect(pool._spy).toHaveBeenCalledWith(
      expect.any(String),
      ["per_w", null, 200],
    );
  });

  it("forwards scope when provided", async () => {
    const pool = makeMockPool([]);
    await listMemoryFacts(pool, "per_w", { scope: "team" });
    expect(pool._spy).toHaveBeenCalledWith(
      expect.any(String),
      ["per_w", "team", 200],
    );
  });

  it("clamps limit to [1, 1000]", async () => {
    const pool = makeMockPool([]);
    await listMemoryFacts(pool, "per_w", { limit: 50 });
    expect(pool._spy).toHaveBeenLastCalledWith(
      expect.any(String),
      ["per_w", null, 50],
    );
    await listMemoryFacts(pool, "per_w", { limit: 9999 });
    expect(pool._spy).toHaveBeenLastCalledWith(
      expect.any(String),
      ["per_w", null, 1000],
    );
    await listMemoryFacts(pool, "per_w", { limit: 0 });
    expect(pool._spy).toHaveBeenLastCalledWith(
      expect.any(String),
      ["per_w", null, 1],
    );
  });

  it("maps merge_origin from source_session_ids cardinality", async () => {
    const pool = makeMockPool([
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
