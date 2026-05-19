import { describe, expect, it, vi } from "vitest";
import type { Agent, AgentRepository } from "@beevibe/core";
import type { MemoryAgent } from "@beevibe/core/services/memory";
import { buildInstructions } from "./instructions.js";

function fakeMemoryAgent(opts: {
  coreOnlySystemPrompt?: string;
} = {}): MemoryAgent {
  return {
    prepareBriefing: vi.fn(async () => ({
      systemPromptAppend: "<core_memory>full briefing</core_memory>",
      userMessagePrefix: "<archival_memory><leak_canary_token/></archival_memory>",
      snapshot: { block_count: 0, fact_count: 0, token_count: 0, blocks: [], facts: [] },
    })),
    prepareCoreOnly: vi.fn(async () => ({
      systemPromptAppend:
        opts.coreOnlySystemPrompt ??
        '<core_memory>\n  <block name="persona">You are Alice\'s team agent.</block>\n</core_memory>',
      userMessagePrefix: "",
      snapshot: { block_count: 1, fact_count: 0, token_count: 10, blocks: [], facts: [] },
    })),
    searchArchival: vi.fn(async () => "<archival_memory></archival_memory>"),
    onTaskComplete: vi.fn(async () => {}),
  };
}

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_b",
    owner_id: "p1",
    parent_id: null,
    hierarchy_level: "team",
    name: "team-agent",
    display_name: "Alice's team",
    api_key: "bv_a_xxx",
    api_key_revoked_at: null,
    onboarding_completed_at: new Date(),
    runtime_config: {
      type: "claude",
      system_prompt_addition: "<agent_baseline>persona stuff</agent_baseline>",
    },
    created_at: new Date(),
    updated_at: new Date(),
    archived_at: null,
    ...overrides,
  } as unknown as Agent;
}

function fakeAgentRepo(opts: {
  agent?: Agent | undefined;
  subordinates?: readonly Agent[];
} = {}): AgentRepository {
  return {
    findById: vi.fn(async () => opts.agent ?? null),
    findSubordinates: vi.fn(async () => opts.subordinates ?? []),
  } as unknown as AgentRepository;
}

describe("buildInstructions", () => {
  it("returns empty string for agent callers (briefing already injected via --append-system-prompt)", async () => {
    const memoryAgent = fakeMemoryAgent();
    const agentRepo = fakeAgentRepo();

    const result = await buildInstructions(
      { source: "agent", agentId: "agent_a", hierarchyLevel: "team" },
      memoryAgent,
      agentRepo,
    );

    expect(result).toBe("");
    // Agent-source path shouldn't query any memory or agent metadata.
    expect(memoryAgent.prepareBriefing).not.toHaveBeenCalled();
    expect(memoryAgent.prepareCoreOnly).not.toHaveBeenCalled();
    expect(agentRepo.findById).not.toHaveBeenCalled();
    expect(agentRepo.findSubordinates).not.toHaveBeenCalled();
  });

  it("composes the full team-chat stack for human team-tier callers", async () => {
    const memoryAgent = fakeMemoryAgent();
    const agentRepo = fakeAgentRepo({
      agent: fakeAgent(),
      subordinates: [
        fakeAgent({ id: "ic_1", name: "frontend", hierarchy_level: "ic" }),
        fakeAgent({ id: "ic_2", name: "backend", hierarchy_level: "ic" }),
      ],
    });

    const result = await buildInstructions(
      { source: "human", agentId: "agent_b", hierarchyLevel: "team", personId: "p1" },
      memoryAgent,
      agentRepo,
    );

    // Universal blocks present.
    expect(result).toContain("beevibe_lifecycle");
    expect(result).toContain("beevibe_memory");
    // Team routing with the roster.
    expect(result).toContain("team_agent_routing");
    expect(result).toContain("- frontend");
    expect(result).toContain("- backend");
    // Per-agent baseline threaded through.
    expect(result).toContain("<agent_baseline>");
    // Core memory present.
    expect(result).toContain("<core_memory>");
    // Things the human-MCP variant must NOT carry.
    expect(result).not.toContain("chat_directives");
    expect(result).not.toContain("onboarding_directives");
    // The memory reminder's prose mentions <archival_memory> / "top-k"
    // describing Layer 2, so neither is a clean negative signal. Use a
    // distinctive canary that only appears in prepareBriefing's mock
    // userMessagePrefix — its absence proves prepareCoreOnly was used.
    expect(result).not.toContain("leak_canary_token");
    // Used prepareCoreOnly, not prepareBriefing — no embed/query wasted on
    // a placeholder retrieval query at MCP init time.
    expect(memoryAgent.prepareCoreOnly).toHaveBeenCalled();
    expect(memoryAgent.prepareBriefing).not.toHaveBeenCalled();
  });

  it("omits team_agent_routing for org-tier humans (routing rubric is team-only today)", async () => {
    const memoryAgent = fakeMemoryAgent();
    const agentRepo = fakeAgentRepo({
      agent: fakeAgent({ hierarchy_level: "org" }),
    });

    const result = await buildInstructions(
      { source: "human", agentId: "agent_org", hierarchyLevel: "org", personId: "p1" },
      memoryAgent,
      agentRepo,
    );

    expect(result).not.toContain("team_agent_routing");
    // But still gets lifecycle + memory + baseline + core_memory.
    expect(result).toContain("beevibe_lifecycle");
    expect(result).toContain("beevibe_memory");
    expect(result).toContain("<agent_baseline>");
    expect(result).toContain("<core_memory>");
    // Subordinate fetch is skipped — org-tier doesn't need the roster
    // (no routing block to populate).
    expect(agentRepo.findSubordinates).not.toHaveBeenCalled();
  });

  it("survives missing agent record without throwing (returns stack minus baseline)", async () => {
    const memoryAgent = fakeMemoryAgent();
    const agentRepo = fakeAgentRepo({ agent: undefined });

    const result = await buildInstructions(
      { source: "human", agentId: "ghost", hierarchyLevel: "team", personId: "p1" },
      memoryAgent,
      agentRepo,
    );

    expect(result).toContain("beevibe_lifecycle");
    expect(result).toContain("<core_memory>");
    // No per-agent baseline content when the agent record is missing.
    expect(result).not.toContain("<agent_baseline>");
  });
});
