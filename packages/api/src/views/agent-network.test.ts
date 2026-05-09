/**
 * Mock-Pool tests for views/agent-network.ts. Two queries (self + peers)
 * fired in parallel; tests verify param forwarding, row mapping, and
 * the per-owner grouping logic that turns a flat peer-row stream into
 * an array of AgentPeerOwner.
 */
import { describe, it, expect } from "vitest";
import { getAgentNetwork } from "./agent-network.js";
import { makeMockPool } from "./test-helpers.js";

const baseSelf = {
  id: "agt_self_team",
  name: "weijia's team",
  owner_id: "per_w",
  parent_agent_id: null,
  hierarchy_level: "team" as const,
  review_policy: null,
  runtime_config: { model: "claude-opus-4-7" },
  created_at: new Date("2026-04-01T00:00:00Z"),
  updated_at: new Date("2026-04-01T00:00:00Z"),
  sessions_count: 12,
  facts_learned: 5,
};

const baseSelfIc = {
  ...baseSelf,
  id: "agt_self_ic",
  name: "backend specialist",
  parent_agent_id: "agt_self_team",
  hierarchy_level: "ic" as const,
  sessions_count: 3,
  facts_learned: 4,
};

const peerTeamDaniel = {
  id: "agt_d_team",
  name: "Daniel's team",
  owner_id: "per_d",
  parent_agent_id: null,
  hierarchy_level: "team" as const,
  review_policy: null,
  runtime_config: { model: "claude-opus-4-7" },
  created_at: new Date("2026-04-02T00:00:00Z"),
  updated_at: new Date("2026-04-02T00:00:00Z"),
  sessions_count: 8,
  facts_learned: 2,
  owner_label: "Daniel",
};

const peerIcDaniel = {
  ...peerTeamDaniel,
  id: "agt_d_ic",
  name: "roadmap specialist",
  parent_agent_id: "agt_d_team",
  hierarchy_level: "ic" as const,
  sessions_count: 1,
  facts_learned: 0,
};

const peerTeamBob = {
  ...peerTeamDaniel,
  id: "agt_b_team",
  name: "bob's team",
  owner_id: "per_b",
  parent_agent_id: null,
  hierarchy_level: "team" as const,
  owner_label: "bob",
  sessions_count: 4,
  facts_learned: 1,
};

describe("getAgentNetwork", () => {
  it("forwards personId to both queries", async () => {
    const pool = makeMockPool([[], []]);
    await getAgentNetwork(pool, "per_w");
    expect(pool._spy).toHaveBeenCalledTimes(2);
    expect(pool._spy).toHaveBeenNthCalledWith(1, expect.any(String), ["per_w"]);
    expect(pool._spy).toHaveBeenNthCalledWith(2, expect.any(String), ["per_w"]);
  });

  it("returns empty self + empty peers when no data", async () => {
    const pool = makeMockPool([[], []]);
    const network = await getAgentNetwork(pool, "per_w");
    expect(network).toEqual({ self: [], peers: [] });
  });

  it("maps self rows to AgentDisplay preserving hierarchy + counts", async () => {
    const pool = makeMockPool([[baseSelf, baseSelfIc], []]);
    const network = await getAgentNetwork(pool, "per_w");
    expect(network.self).toHaveLength(2);
    expect(network.self[0]).toMatchObject({
      id: "agt_self_team",
      hierarchy: "team",
      sessions_count: 12,
      facts_learned: 5,
    });
    expect(network.self[1]).toMatchObject({
      id: "agt_self_ic",
      hierarchy: "ic",
      parent_agent_id: "agt_self_team",
    });
  });

  it("groups peer rows by owner_id into AgentPeerOwner[]", async () => {
    const pool = makeMockPool([
      [],
      [peerTeamDaniel, peerIcDaniel, peerTeamBob],
    ]);
    const network = await getAgentNetwork(pool, "per_w");
    expect(network.peers).toHaveLength(2);
    const daniel = network.peers.find((p) => p.owner_id === "per_d");
    const bob = network.peers.find((p) => p.owner_id === "per_b");
    expect(daniel?.owner_label).toBe("Daniel");
    expect(daniel?.agents).toHaveLength(2);
    expect(daniel?.agents.map((a) => a.id)).toEqual(["agt_d_team", "agt_d_ic"]);
    expect(bob?.owner_label).toBe("bob");
    expect(bob?.agents).toHaveLength(1);
  });

  it("preserves SQL row order within each peer-owner bucket", async () => {
    // Peer rows arrive sorted (team first, then ICs). Grouping must
    // not shuffle; the UI relies on team-at-index-0 for orbit centers.
    const pool = makeMockPool([
      [],
      [peerTeamDaniel, peerIcDaniel],
    ]);
    const { peers } = await getAgentNetwork(pool, "per_w");
    expect(peers[0]?.agents[0]?.hierarchy).toBe("team");
    expect(peers[0]?.agents[1]?.hierarchy).toBe("ic");
  });
});
