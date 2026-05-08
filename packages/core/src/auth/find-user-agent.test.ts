import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../domain/agent.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import { findUserAgent } from "./find-user-agent.js";
import { makeAgentRepoFake } from "./test-fakes.js";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_1",
    name: "Test",
    owner_id: "person_1",
    hierarchy_level: "team",
    runtime_config: { type: "claude", model: "claude-opus-4-7" },
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

let agentRepo: AgentRepository;

beforeEach(() => {
  agentRepo = makeAgentRepoFake();
});

describe("findUserAgent", () => {
  it("returns the team agent when findTopLevelForOwner returns one", async () => {
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(
      makeAgent({ id: "agent_team_alice", hierarchy_level: "team" }),
    );
    const out = await findUserAgent(agentRepo, "person_alice");
    expect(out).toEqual({ agentId: "agent_team_alice", hierarchyLevel: "team" });
    expect(agentRepo.findTopLevelForOwner).toHaveBeenCalledWith("person_alice");
  });

  it("returns the org agent when that's all the person has", async () => {
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(
      makeAgent({ id: "agent_org", hierarchy_level: "org" }),
    );
    const out = await findUserAgent(agentRepo, "person_solo");
    expect(out).toEqual({ agentId: "agent_org", hierarchyLevel: "org" });
  });

  it("returns undefined when the person has no team/org agent", async () => {
    vi.mocked(agentRepo.findTopLevelForOwner).mockResolvedValue(undefined);
    const out = await findUserAgent(agentRepo, "person_no_agent");
    expect(out).toBeUndefined();
  });
});
