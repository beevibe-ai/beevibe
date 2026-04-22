import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../domain/agent.js";
import type { CoreMemoryBlock } from "../domain/core-memory.js";
import type { AgentRepository, NewAgent } from "../ports/agent-repo.js";
import type { CoreMemoryBlockRepository } from "../ports/core-memory-repo.js";
import { AgentService } from "./agent-service.js";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_abc",
    name: "Test Agent",
    owner_id: "person_abc",
    hierarchy_level: "ic",
    runtime_config: { type: "claude-code", model: "claude-opus-4-7" },
    created_at: new Date("2026-04-22T00:00:00Z"),
    updated_at: new Date("2026-04-22T00:00:00Z"),
    ...overrides,
  };
}

function makeBlock(name: string, agentId: string): CoreMemoryBlock {
  return {
    id: `block_${name}`,
    agent_id: agentId,
    block_name: name,
    content: "",
    char_limit: 2000,
    is_system: true,
    created_at: new Date("2026-04-22T00:00:00Z"),
    updated_at: new Date("2026-04-22T00:00:00Z"),
  };
}

let agentRepo: AgentRepository;
let coreMemoryRepo: CoreMemoryBlockRepository;

beforeEach(() => {
  agentRepo = {
    findById: vi.fn(),
    findByApiKey: vi.fn(),
    findByOwnerId: vi.fn(),
    findTopLevelForOwner: vi.fn(),
    findSubordinates: vi.fn(),
    findPeers: vi.fn(),
    findByLevel: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  coreMemoryRepo = {
    findByAgent: vi.fn(),
    findOne: vi.fn(),
    upsert: vi.fn(),
    updateContent: vi.fn(),
    delete: vi.fn(),
    initDefaults: vi.fn(),
  };
});

describe("AgentService.create", () => {
  it("creates the agent then initializes default core-memory blocks for its hierarchy level", async () => {
    const created = makeAgent({ id: "agent_new", hierarchy_level: "ic" });
    const blocks = ["persona", "domain", "active_context", "constraints"].map((n) =>
      makeBlock(n, "agent_new"),
    );
    vi.mocked(agentRepo.create).mockResolvedValue(created);
    vi.mocked(coreMemoryRepo.initDefaults).mockResolvedValue(blocks);

    const service = new AgentService({ agentRepo, coreMemoryRepo });
    const input: NewAgent = {
      id: "agent_new",
      name: "Alice",
      owner_id: "person_alice",
      hierarchy_level: "ic",
      runtime_config: { type: "claude-code", model: "claude-opus-4-7" },
    };

    const result = await service.create(input);

    expect(agentRepo.create).toHaveBeenCalledWith(input);
    expect(coreMemoryRepo.initDefaults).toHaveBeenCalledWith("agent_new", "ic");
    expect(result.agent).toBe(created);
    expect(result.blocks).toBe(blocks);
  });

  it("passes the agent's actual hierarchy_level to initDefaults (team agent)", async () => {
    const created = makeAgent({ id: "agent_team", hierarchy_level: "team" });
    vi.mocked(agentRepo.create).mockResolvedValue(created);
    vi.mocked(coreMemoryRepo.initDefaults).mockResolvedValue([]);

    await new AgentService({ agentRepo, coreMemoryRepo }).create({
      id: "agent_team",
      name: "Team Lead",
      owner_id: "person_x",
      hierarchy_level: "team",
      runtime_config: { type: "claude-code", model: "claude-opus-4-7" },
    });

    expect(coreMemoryRepo.initDefaults).toHaveBeenCalledWith("agent_team", "team");
  });

  it("does NOT call initDefaults if agentRepo.create throws (no orphan blocks)", async () => {
    vi.mocked(agentRepo.create).mockRejectedValue(new Error("agent exists"));

    await expect(
      new AgentService({ agentRepo, coreMemoryRepo }).create({
        id: "agent_dup",
        name: "Dup",
        owner_id: "person_x",
        hierarchy_level: "ic",
        runtime_config: { type: "claude-code", model: "claude-opus-4-7" },
      }),
    ).rejects.toThrow("agent exists");

    expect(coreMemoryRepo.initDefaults).not.toHaveBeenCalled();
  });

  it("propagates initDefaults failure after agent create (documented orphan-agent limitation)", async () => {
    const created = makeAgent({ id: "agent_orphan" });
    vi.mocked(agentRepo.create).mockResolvedValue(created);
    vi.mocked(coreMemoryRepo.initDefaults).mockRejectedValue(new Error("db down"));

    await expect(
      new AgentService({ agentRepo, coreMemoryRepo }).create({
        id: "agent_orphan",
        name: "Orphan",
        owner_id: "person_x",
        hierarchy_level: "ic",
        runtime_config: { type: "claude-code", model: "claude-opus-4-7" },
      }),
    ).rejects.toThrow("db down");

    expect(agentRepo.create).toHaveBeenCalled();
    expect(coreMemoryRepo.initDefaults).toHaveBeenCalled();
  });
});
