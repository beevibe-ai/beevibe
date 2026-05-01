/**
 * Mock-Pool tests for views/promotions.ts. Validates row → DTO mapping
 * (including session truncation + extra count) without a database.
 */
import { describe, it, expect } from "vitest";
import { listPromotions } from "./promotions.js";
import { makeMockPool } from "./test-helpers.js";

const baseRow = {
  id: "mpe_1",
  fact_id: "fact_1",
  from_scope: "ic" as const,
  to_scope: "team" as const,
  origin_agent_id: "agt_a",
  promoter_reason: "looks team-relevant",
  source_session_ids: ["sess_a", "sess_b"],
  rejected: false,
  created_at: new Date("2026-04-30T10:00:00Z"),
  fact_type: "pattern" as const,
  fact_content: "always run tests",
  origin_agent_label: "Alice",
};

describe("listPromotions", () => {
  it("forwards owner + clamped limit to the SQL", async () => {
    const pool = makeMockPool([]);
    await listPromotions(pool, "per_w", { limit: 50 });
    expect(pool._spy).toHaveBeenCalledWith(expect.any(String), ["per_w", 50]);
  });

  it("clamps limit to [1, 500] and defaults to 100", async () => {
    const pool = makeMockPool([]);
    await listPromotions(pool, "per_w");
    expect(pool._spy).toHaveBeenLastCalledWith(expect.any(String), ["per_w", 100]);
    await listPromotions(pool, "per_w", { limit: 9999 });
    expect(pool._spy).toHaveBeenLastCalledWith(expect.any(String), ["per_w", 500]);
    await listPromotions(pool, "per_w", { limit: 0 });
    expect(pool._spy).toHaveBeenLastCalledWith(expect.any(String), ["per_w", 1]);
  });

  it("maps a single row preserving fact + agent joined fields", async () => {
    const pool = makeMockPool([baseRow]);
    const events = await listPromotions(pool, "per_w");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: "mpe_1",
      fact_id: "fact_1",
      fact_type: "pattern",
      fact_content: "always run tests",
      from_scope: "ic",
      to_scope: "team",
      origin_agent_id: "agt_a",
      origin_agent_label: "Alice",
      promoter_reason: "looks team-relevant",
      source_session_ids: ["sess_a", "sess_b"],
      created_at: new Date("2026-04-30T10:00:00Z"),
      rejected: false,
    });
  });

  it("truncates source_session_ids to 3 and exposes overflow as source_session_extra", async () => {
    const pool = makeMockPool([
      {
        ...baseRow,
        source_session_ids: ["s1", "s2", "s3", "s4", "s5"],
      },
    ]);
    const [event] = await listPromotions(pool, "per_w");
    expect(event?.source_session_ids).toEqual(["s1", "s2", "s3"]);
    expect(event?.source_session_extra).toBe(2);
  });

  it("omits source_session_extra when no overflow", async () => {
    const pool = makeMockPool([{ ...baseRow, source_session_ids: ["s1", "s2"] }]);
    const [event] = await listPromotions(pool, "per_w");
    expect(event?.source_session_extra).toBeUndefined();
  });

  it("preserves rejected boolean (true and false both surface)", async () => {
    const pool = makeMockPool([
      { ...baseRow, id: "mpe_yes", rejected: false },
      { ...baseRow, id: "mpe_no", rejected: true },
    ]);
    const events = await listPromotions(pool, "per_w");
    expect(events[0]?.rejected).toBe(false);
    expect(events[1]?.rejected).toBe(true);
  });

  it("preserves null from_scope (forward-compat for fact-creation events)", async () => {
    const pool = makeMockPool([{ ...baseRow, from_scope: null }]);
    const [event] = await listPromotions(pool, "per_w");
    expect(event?.from_scope).toBeNull();
  });
});
