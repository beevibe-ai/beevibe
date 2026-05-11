/**
 * Mock-Pool tests for views/mesh.ts. Validates row → DTO mapping +
 * status compression. Real query correctness is covered by integration
 * tests; these stay DB-free.
 *
 * Query order in the implementation:
 *   1) NEGOTIATIONS_SQL   → recent + in-flight negotiations
 *   2) MESH_SESSIONS_SQL  → mesh_ask + blocker session rows
 *   3) NODES_SQL          → distinct involved agents
 *   4) EDGES_SQL          → aggregated initiator → counterparty pairs
 *   5) SUMMARY_SQL        → total counts
 */
import { describe, it, expect } from "vitest";
import { getMeshOverview } from "./mesh.js";
import { makeMockPool } from "./test-helpers.js";

const baseAsk = {
  id: "neg_1",
  caller_id: "agt_a",
  caller_label: "Alice",
  target_id: "agt_b",
  target_label: "Bob",
  source_task_id: "task_1",
  rounds_completed: 2,
  max_rounds: 5,
  started_at: new Date("2026-04-30T11:00:00Z"),
  completed_at_or_updated: new Date("2026-04-30T11:30:00Z"),
  intent: "Can you review this?",
};

describe("getMeshOverview — asks", () => {
  it("returns empty arrays + zero summary when DB is empty", async () => {
    const pool = makeMockPool([[], [], [], [], []]);
    const overview = await getMeshOverview(pool);
    expect(overview.asks).toEqual([]);
    expect(overview.graph.nodes).toEqual([]);
    expect(overview.graph.edges).toEqual([]);
    expect(overview.summary).toEqual({ asks_24h: 0, in_flight: 0, edge_count: 0 });
  });

  it("maps an active negotiation to in_flight + omits completed_at", async () => {
    const pool = makeMockPool([
      [{ ...baseAsk, status: "active" }],
      [],
      [],
      [],
      [],
    ]);
    const { asks } = await getMeshOverview(pool);
    expect(asks).toHaveLength(1);
    expect(asks[0]?.status).toBe("in_flight");
    expect(asks[0]?.completed_at).toBeUndefined();
    expect(asks[0]?.caller_label).toBe("Alice");
    expect(asks[0]?.target_label).toBe("Bob");
    expect(asks[0]?.intent).toBe("Can you review this?");
    expect(asks[0]?.rounds_completed).toBe(2);
    expect(asks[0]?.max_rounds).toBe(5);
  });

  it("compresses negotiation.status into MeshAskStatus", async () => {
    const pool = makeMockPool([
      [
        { ...baseAsk, id: "neg_a", status: "active" },
        { ...baseAsk, id: "neg_b", status: "accepted" },
        { ...baseAsk, id: "neg_c", status: "rejected" },
        { ...baseAsk, id: "neg_d", status: "escalated" },
        { ...baseAsk, id: "neg_e", status: "cancelled" },
      ],
      [],
      [],
      [],
      [],
    ]);
    const { asks } = await getMeshOverview(pool);
    const statusByid = Object.fromEntries(asks.map((a) => [a.id, a.status]));
    expect(statusByid).toEqual({
      neg_a: "in_flight",
      neg_b: "succeeded",
      neg_c: "rejected",
      neg_d: "escalated",
      neg_e: "blocked",
    });
  });

  it("populates completed_at from updated_at for terminal asks", async () => {
    const pool = makeMockPool([
      [{ ...baseAsk, status: "accepted" }],
      [],
      [],
      [],
      [],
    ]);
    const { asks } = await getMeshOverview(pool);
    expect(asks[0]?.completed_at).toEqual(new Date("2026-04-30T11:30:00Z"));
  });

  it("falls back to '(no message)' when round 1 message is null", async () => {
    const pool = makeMockPool([
      [{ ...baseAsk, status: "active", intent: null }],
      [],
      [],
      [],
      [],
    ]);
    const { asks } = await getMeshOverview(pool);
    expect(asks[0]?.intent).toBe("(no message)");
  });
});

describe("getMeshOverview — mesh-ask + blocker sessions", () => {
  it("maps a running mesh_ask session to type='ask' + extracts inner intent", async () => {
    const pool = makeMockPool([
      [],
      [
        {
          id: "sess_ask01",
          caller_id: "agt_a",
          caller_label: "Alice",
          target_id: "agt_b",
          target_label: "Bob",
          kind: "mesh_ask",
          session_status: "running",
          source_task_id: "task_1",
          started_at: new Date("2026-04-30T12:00:00Z"),
          completed_at: null,
          intent:
            '<mesh-ask request_id="req_1" from="agt_a">What is the SLA?</mesh-ask>',
        },
      ],
      [],
      [],
      [],
    ]);
    const { asks } = await getMeshOverview(pool);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      type: "ask",
      status: "in_flight",
      caller_label: "Alice",
      target_label: "Bob",
      intent: "What is the SLA?",
    });
    expect(asks[0]?.completed_at).toBeUndefined();
  });

  it("maps a completed blocker session to type='blocker' + sets completed_at", async () => {
    const pool = makeMockPool([
      [],
      [
        {
          id: "sess_blk01",
          caller_id: "agt_c",
          caller_label: "Charlie",
          target_id: "agt_team",
          target_label: "Team",
          kind: "blocker",
          session_status: "completed",
          source_task_id: "task_42",
          started_at: new Date("2026-04-30T13:00:00Z"),
          completed_at: new Date("2026-04-30T13:10:00Z"),
          intent:
            '<mesh-blocker from="agt_c" task_id="task_42">\nDB credentials expired.\n</mesh-blocker>\n<context>...</context>',
        },
      ],
      [],
      [],
      [],
    ]);
    const { asks } = await getMeshOverview(pool);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({
      type: "blocker",
      status: "succeeded",
      intent: "DB credentials expired.",
    });
    expect(asks[0]?.completed_at).toEqual(new Date("2026-04-30T13:10:00Z"));
  });

  it("drops session rows where caller_id failed to resolve to an agent", async () => {
    const pool = makeMockPool([
      [],
      [
        {
          id: "sess_orphan",
          caller_id: null,
          caller_label: null,
          target_id: "agt_b",
          target_label: "Bob",
          kind: "mesh_ask",
          session_status: "running",
          source_task_id: null,
          started_at: new Date("2026-04-30T12:00:00Z"),
          completed_at: null,
          intent: "<mesh-ask>orphaned</mesh-ask>",
        },
      ],
      [],
      [],
      [],
    ]);
    const { asks } = await getMeshOverview(pool);
    expect(asks).toEqual([]);
  });

  it("merges negotiation + session asks sorted by started_at desc", async () => {
    const pool = makeMockPool([
      [{ ...baseAsk, id: "neg_old", status: "active", started_at: new Date("2026-04-30T10:00:00Z") }],
      [
        {
          id: "sess_new",
          caller_id: "agt_a",
          caller_label: "Alice",
          target_id: "agt_b",
          target_label: "Bob",
          kind: "mesh_ask",
          session_status: "running",
          source_task_id: null,
          started_at: new Date("2026-04-30T14:00:00Z"),
          completed_at: null,
          intent: '<mesh-ask from="agt_a">newer ask</mesh-ask>',
        },
      ],
      [],
      [],
      [],
    ]);
    const { asks } = await getMeshOverview(pool);
    expect(asks.map((a) => a.id)).toEqual(["sess_new", "neg_old"]);
  });
});

describe("getMeshOverview — nodes + edges + summary", () => {
  it("maps node rows preserving hierarchy and active state", async () => {
    const pool = makeMockPool([
      [],
      [],
      [
        { id: "agt_a", label: "Alice", hier: "team", is_active: true },
        { id: "agt_b", label: "Bob", hier: "ic", is_active: false },
      ],
      [],
      [],
    ]);
    const { graph } = await getMeshOverview(pool);
    expect(graph.nodes).toEqual([
      { id: "agt_a", label: "Alice", hier: "team", state: "active" },
      { id: "agt_b", label: "Bob", hier: "ic", state: "idle" },
    ]);
  });

  it("maps edges with count + live state", async () => {
    const pool = makeMockPool([
      [],
      [],
      [],
      [
        { from_id: "agt_a", to_id: "agt_b", count: 3, has_live: true },
        { from_id: "agt_a", to_id: "agt_c", count: 1, has_live: false },
      ],
      [],
    ]);
    const { graph } = await getMeshOverview(pool);
    expect(graph.edges).toEqual([
      { from: "agt_a", to: "agt_b", count: 3, state: "live" },
      { from: "agt_a", to: "agt_c", count: 1, state: "completed" },
    ]);
  });

  it("forwards summary counts", async () => {
    const pool = makeMockPool([
      [],
      [],
      [],
      [],
      [{ asks_24h: 12, in_flight: 3, edge_count: 7 }],
    ]);
    const { summary } = await getMeshOverview(pool);
    expect(summary).toEqual({ asks_24h: 12, in_flight: 3, edge_count: 7 });
  });
});
