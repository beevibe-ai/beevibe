import { describe, it, expect } from "vitest";
import { overviewToDisplay } from "./mesh-display";
import type { MeshOverview } from "@/lib/types/mesh";

function emptyOverview(): MeshOverview {
  return {
    asks: [],
    graph: { nodes: [], edges: [] },
    summary: { asks_24h: 0, in_flight: 0, edge_count: 0 },
  };
}

describe("overviewToDisplay — asks", () => {
  it("maps caller/target labels + duration_label + chain depth", () => {
    const overview: MeshOverview = {
      ...emptyOverview(),
      asks: [
        {
          id: "neg_1",
          type: "negotiate",
          caller_id: "agt_a",
          caller_label: "Alice",
          target_id: "agt_b",
          target_label: "Bob",
          status: "in_flight",
          intent: "review the schema",
          started_at: new Date("2026-04-30T11:00:00Z"),
          completed_at: new Date("2026-04-30T11:30:00Z"),
          rounds_completed: 2,
          max_rounds: 5,
        },
      ],
    };
    const { asks } = overviewToDisplay(overview);
    expect(asks).toHaveLength(1);
    expect(asks[0]?.caller).toBe("Alice");
    expect(asks[0]?.target).toBe("Bob");
    expect(asks[0]?.duration_label).toBe("30m");
    expect(asks[0]?.chain_depth).toBe("2/5");
    expect(asks[0]?.intent).toBe("review the schema");
  });

  it("compresses rejected + escalated to blocked for the UI's 3-status palette", () => {
    const overview: MeshOverview = {
      ...emptyOverview(),
      asks: (
        ["in_flight", "succeeded", "rejected", "blocked", "escalated"] as const
      ).map((status, i) => ({
        id: `neg_${i}`,
        type: "negotiate" as const,
        caller_id: "agt_a",
        caller_label: "A",
        target_id: "agt_b",
        target_label: "B",
        status,
        intent: "x",
        started_at: new Date(),
      })),
    };
    const { asks } = overviewToDisplay(overview);
    expect(asks.map((a) => a.status)).toEqual([
      "in_flight",
      "succeeded",
      "blocked",
      "blocked",
      "blocked",
    ]);
  });

  it("uses '—' for chain_depth when rounds aren't tracked", () => {
    const overview: MeshOverview = {
      ...emptyOverview(),
      asks: [
        {
          id: "ask_1",
          type: "ask",
          caller_id: "agt_a",
          caller_label: "A",
          target_id: "agt_b",
          target_label: "B",
          status: "succeeded",
          intent: "x",
          started_at: new Date(),
        },
      ],
    };
    expect(overviewToDisplay(overview).asks[0]?.chain_depth).toBe("—");
  });
});

describe("overviewToDisplay — graph layout", () => {
  it("places N nodes on a circle and produces SVG paths for edges", () => {
    const overview: MeshOverview = {
      ...emptyOverview(),
      graph: {
        nodes: [
          { id: "agt_a", label: "Alice", hier: "team", state: "active" },
          { id: "agt_b", label: "Bob", hier: "ic", state: "idle" },
          { id: "agt_c", label: "Carol", hier: "ic", state: "active" },
        ],
        edges: [
          { from: "agt_a", to: "agt_b", count: 1, state: "live" },
          { from: "agt_a", to: "agt_c", count: 2, state: "completed" },
        ],
      },
    };
    const { graph } = overviewToDisplay(overview);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
    for (const node of graph.nodes) {
      expect(node.cx).toBeGreaterThan(0);
      expect(node.cy).toBeGreaterThan(0);
      expect(node.r).toBeGreaterThan(0);
    }
    expect(graph.edges[0]?.d).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
  });

  it("orders nodes by hierarchy (org → team → ic) then by name", () => {
    const overview: MeshOverview = {
      ...emptyOverview(),
      graph: {
        nodes: [
          { id: "agt_z", label: "Zed", hier: "ic", state: "idle" },
          { id: "agt_o", label: "Orin", hier: "org", state: "idle" },
          { id: "agt_t", label: "Tara", hier: "team", state: "idle" },
        ],
        edges: [],
      },
    };
    const labels = overviewToDisplay(overview).graph.nodes.map((n) => n.label);
    expect(labels).toEqual(["Orin", "Tara", "Zed"]);
  });

  it("drops edges whose endpoints aren't in the node list (defensive)", () => {
    const overview: MeshOverview = {
      ...emptyOverview(),
      graph: {
        nodes: [{ id: "agt_a", label: "A", hier: "ic", state: "idle" }],
        edges: [{ from: "agt_a", to: "agt_missing", count: 1, state: "completed" }],
      },
    };
    expect(overviewToDisplay(overview).graph.edges).toHaveLength(0);
  });
});

describe("overviewToDisplay — summary passthrough", () => {
  it("forwards summary counts unchanged", () => {
    const overview: MeshOverview = {
      ...emptyOverview(),
      summary: { asks_24h: 12, in_flight: 3, edge_count: 7 },
    };
    expect(overviewToDisplay(overview).summary).toEqual({
      asks_24h: 12,
      in_flight: 3,
      edge_count: 7,
    });
  });
});
