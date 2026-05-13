import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "../domain/agent.js";
import type { CoreMemoryBlock } from "../domain/core-memory.js";
import type { Person } from "../domain/person.js";
import type { AgentRepository } from "../ports/agent-repo.js";
import type { CoreMemoryBlockRepository } from "../ports/core-memory-repo.js";
import type { PersonRepository } from "../ports/person-repo.js";
import { provisionAgent, provisionUser } from "./provision.js";
import {
  makeAgentRepoFake,
  makeCoreMemoryRepoFake,
  makePersonRepoFake,
} from "./test-fakes.js";

function makeBlocks(agentId: string): CoreMemoryBlock[] {
  return ["tag_line", "persona", "domain", "active_context", "constraints"].map((name) => ({
    id: `block_${name}`,
    agent_id: agentId,
    block_name: name,
    content: "",
    char_limit: name === "tag_line" ? 100 : 2000,
    is_system: true,
    description: "",
    created_at: new Date(),
    updated_at: new Date(),
  }));
}

let agentRepo: AgentRepository;
let coreMemoryRepo: CoreMemoryBlockRepository;
let personRepo: PersonRepository;

beforeEach(() => {
  agentRepo = makeAgentRepoFake();
  coreMemoryRepo = makeCoreMemoryRepoFake();
  personRepo = makePersonRepoFake();
});

describe("provisionAgent", () => {
  it("generates a bv_a_ key, creates the agent with it, and inits default blocks", async () => {
    vi.mocked(agentRepo.create).mockImplementation(async (input) =>
      ({
        ...input,
        created_at: new Date(),
        updated_at: new Date(),
      }) as Agent,
    );
    vi.mocked(coreMemoryRepo.initDefaults).mockImplementation(async (agentId) =>
      makeBlocks(agentId),
    );

    const out = await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: "agent_1",
        name: "Provisioned",
        owner_id: "person_1",
        hierarchy_level: "ic",
        runtime_config: { type: "claude", model: "claude-opus-4-7" },
      },
    );

    expect(out.apiKey).toMatch(/^bv_a_[0-9A-Za-z]{24}$/);
    expect(out.agent.api_key).toBe(out.apiKey);
    expect(out.agent.id).toBe("agent_1");
    expect(out.blocks).toHaveLength(5);

    expect(agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "agent_1",
        api_key: out.apiKey,
        // Default for newly-provisioned agents: tasks they declare done
        // close immediately. Users can flip to 'require_human' later.
        review_policy: "auto_done",
      }),
    );
    expect(coreMemoryRepo.initDefaults).toHaveBeenCalledWith("agent_1", "ic");
  });

  it("preserves an explicit review_policy override", async () => {
    vi.mocked(agentRepo.create).mockImplementation(async (input) =>
      ({
        ...input,
        created_at: new Date(),
        updated_at: new Date(),
      }) as Agent,
    );
    vi.mocked(coreMemoryRepo.initDefaults).mockResolvedValue([]);

    await provisionAgent(
      { agentRepo, coreMemoryRepo },
      {
        id: "agent_2",
        name: "GatedSpecialist",
        owner_id: "person_1",
        hierarchy_level: "ic",
        runtime_config: { type: "claude" },
        review_policy: "require_human",
      },
    );

    expect(agentRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ review_policy: "require_human" }),
    );
  });

  it("propagates errors from initDefaults (documented non-transactional limitation)", async () => {
    vi.mocked(agentRepo.create).mockResolvedValue({
      id: "agent_1",
      name: "X",
      owner_id: "person_1",
      hierarchy_level: "ic",
      runtime_config: { type: "claude", model: "claude-opus-4-7" },
      api_key: "bv_a_abc",
      created_at: new Date(),
      updated_at: new Date(),
    });
    vi.mocked(coreMemoryRepo.initDefaults).mockRejectedValue(new Error("block init failed"));

    await expect(
      provisionAgent(
        { agentRepo, coreMemoryRepo },
        {
          id: "agent_1",
          name: "X",
          owner_id: "person_1",
          hierarchy_level: "ic",
          runtime_config: { type: "claude", model: "claude-opus-4-7" },
        },
      ),
    ).rejects.toThrow(/block init failed/);

    // Agent row was created despite the subsequent failure — documents the limitation.
    expect(agentRepo.create).toHaveBeenCalledOnce();
  });
});

describe("provisionUser", () => {
  it("generates a bv_u_ key and inserts the person with it set", async () => {
    vi.mocked(personRepo.create).mockImplementation(async (input) =>
      ({
        ...input,
        created_at: new Date(),
        updated_at: new Date(),
      }) as Person,
    );

    const out = await provisionUser(
      { personRepo },
      { id: "person_1", name: "Alice", email: "alice@example.com" },
    );

    expect(out.apiKey).toMatch(/^bv_u_[0-9A-Za-z]{24}$/);
    expect(out.person.api_key).toBe(out.apiKey);
    expect(out.person.id).toBe("person_1");
    expect(out.person.email).toBe("alice@example.com");

    expect(personRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: "person_1", api_key: out.apiKey }),
    );
  });

  it("works without an email", async () => {
    vi.mocked(personRepo.create).mockImplementation(async (input) =>
      ({
        ...input,
        created_at: new Date(),
        updated_at: new Date(),
      }) as Person,
    );
    const out = await provisionUser(
      { personRepo },
      { id: "person_1", name: "NoEmail" },
    );
    expect(out.person.email).toBeUndefined();
  });
});
