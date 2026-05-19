import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreMemoryBlock } from "../../domain/core-memory.js";
import type { MemoryFact } from "../../domain/memory.js";
import type { EmbeddingService } from "../../ports/embedding-service.js";
import type { CoreMemory } from "./core-memory.js";
import type { FactPromoter, PromotionResult } from "./fact-promoter.js";
import type { FactStore } from "./fact-store.js";
import type { MemoryPromotionEventRepository } from "../../ports/promotion-event-repo.js";
import { createMemoryAgent, type MemoryAgent } from "./memory-agent.js";

function makeBlock(name: string, content: string): CoreMemoryBlock {
  return {
    id: `block_${name}`,
    agent_id: "agent_1",
    block_name: name,
    content,
    char_limit: 2000,
    is_system: true,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

// Fixed date so renderFact's `saved="YYYY-MM-DD"` attribute is predictable
// across test runs. Override per-fact when a test wants a different date
// (e.g. to assert the staleness annotation matches the row's created_at).
const FIXED_CREATED_AT = new Date("2026-01-15T00:00:00Z");

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "fact_1",
    agent_id: "agent_1",
    scope: "ic",
    fact_type: "preference",
    content: "Uses pnpm.",
    embedding: [],
    source_session_ids: ["sess_1"],
    created_at: FIXED_CREATED_AT,
    ...overrides,
  };
}

let coreMemory: CoreMemory;
let factStore: FactStore;
let promoter: FactPromoter;
let embed: EmbeddingService;
let agent: MemoryAgent;

beforeEach(() => {
  coreMemory = {
    read: vi.fn(),
    applyUpdate: vi.fn(),
    initDefaults: vi.fn(),
  } as unknown as CoreMemory;
  factStore = {
    addOrMerge: vi.fn(),
    updateScope: vi.fn(),
    search: vi.fn(),
    listBySessionId: vi.fn(),
  } as unknown as FactStore;
  promoter = {
    evaluate: vi.fn(),
  } as unknown as FactPromoter;
  embed = {
    type: "fake",
    embed: vi.fn(),
    embedBatch: vi.fn(),
  };
  agent = createMemoryAgent({
    agentId: "agent_1",
    coreMemory,
    factStore,
    promoter,
    embed,
  });
});

describe("MemoryAgent.prepareBriefing", () => {
  it("composes XML with core blocks + fact search results", async () => {
    vi.mocked(coreMemory.read).mockResolvedValue([
      makeBlock("persona", "Senior infra engineer."),
      makeBlock("domain", "TypeScript, Postgres."),
    ]);
    vi.mocked(embed.embed).mockResolvedValue([0.1, 0.2]);
    vi.mocked(factStore.search).mockResolvedValue([
      makeFact({ content: "Prefers pnpm over npm.", scope: "ic", fact_type: "preference" }),
      makeFact({
        id: "fact_2",
        content: "DB schema is on public.",
        scope: "team",
        fact_type: "gotcha",
      }),
    ]);

    const briefing = await agent.prepareBriefing("Add logging to the auth module.");

    // M9.4: core_memory in system prompt; archival_memory in user message
    // prefix; memory_tools section dropped (covered by skill #10).
    expect(briefing.systemPromptAppend).toContain("<core_memory>");
    expect(briefing.systemPromptAppend).toContain(
      '<block name="persona">Senior infra engineer.</block>',
    );
    expect(briefing.systemPromptAppend).toContain(
      '<block name="domain">TypeScript, Postgres.</block>',
    );
    expect(briefing.systemPromptAppend).not.toContain("<archival_memory>");
    expect(briefing.systemPromptAppend).not.toContain("<memory_tools>");

    expect(briefing.userMessagePrefix).toContain("<archival_memory>");
    expect(briefing.userMessagePrefix).toContain(
      '<fact type="preference" scope="ic" saved="2026-01-15">Prefers pnpm over npm.</fact>',
    );
    expect(briefing.userMessagePrefix).toContain(
      '<fact type="gotcha" scope="team" saved="2026-01-15">DB schema is on public.</fact>',
    );
    expect(briefing.userMessagePrefix).not.toContain("<core_memory>");

    expect(briefing.snapshot.block_count).toBe(2);
    expect(briefing.snapshot.fact_count).toBe(2);
    expect(briefing.snapshot.token_count).toBeGreaterThan(0);
    expect(briefing.snapshot.blocks[0]).toMatchObject({
      name: "persona",
      preview: "Senior infra engineer.",
    });
    expect(briefing.snapshot.facts[0]).toMatchObject({
      scope: "ic",
      content: "Prefers pnpm over npm.",
    });
  });

  it("passes the intent's embedding through to FactStore.search with the recall floor", async () => {
    vi.mocked(coreMemory.read).mockResolvedValue([]);
    vi.mocked(embed.embed).mockResolvedValue([0.3, 0.4]);
    vi.mocked(factStore.search).mockResolvedValue([]);

    await agent.prepareBriefing("Fix login bug.");

    expect(embed.embed).toHaveBeenCalledWith("Fix login bug.");
    expect(factStore.search).toHaveBeenCalledWith({
      agent_id: "agent_1",
      scope: ["ic", "team", "org"],
      embedding: [0.3, 0.4],
      limit: 10,
      min_similarity: 0.35,
    });
  });

  it("escapes XML-special characters in block + fact content", async () => {
    vi.mocked(coreMemory.read).mockResolvedValue([
      makeBlock("persona", "knows <html> & JSX"),
    ]);
    vi.mocked(embed.embed).mockResolvedValue([]);
    vi.mocked(factStore.search).mockResolvedValue([
      makeFact({ content: "works with <div> tags" }),
    ]);

    const briefing = await agent.prepareBriefing("x");
    // System prompt: core_memory (escaped block content)
    expect(briefing.systemPromptAppend).toContain("knows &lt;html&gt; &amp; JSX");
    // User message: archival_memory (escaped fact content)
    expect(briefing.userMessagePrefix).toContain("works with &lt;div&gt; tags");

    const allText = briefing.systemPromptAppend + briefing.userMessagePrefix;
    const contentOnly = allText
      .replace(/<\/?core_memory>|<\/?archival_memory>/g, "")
      .replace(/<block [^>]+>/g, "")
      .replace(/<\/block>/g, "")
      .replace(/<fact [^>]+>/g, "")
      .replace(/<\/fact>/g, "");
    expect(contentOnly).not.toMatch(/<div>/);
    expect(contentOnly).not.toMatch(/<html>/);
  });

  it("renders empty <core_memory> in system prompt and EMPTY userMessagePrefix when there's nothing to show", async () => {
    vi.mocked(coreMemory.read).mockResolvedValue([]);
    vi.mocked(embed.embed).mockResolvedValue([]);
    vi.mocked(factStore.search).mockResolvedValue([]);

    const briefing = await agent.prepareBriefing("anything");
    // M9.4: empty <core_memory> still rendered (caller can rely on the tag);
    // userMessagePrefix is empty entirely (no <archival_memory> wrapper for
    // zero facts — keeps the user message clean when there's nothing to show).
    expect(briefing.systemPromptAppend).toMatch(/<core_memory>\s*<\/core_memory>/);
    expect(briefing.userMessagePrefix).toBe("");
    expect(briefing.snapshot.block_count).toBe(0);
    expect(briefing.snapshot.fact_count).toBe(0);
  });

  it("accepts a custom factsPerBriefing limit", async () => {
    const custom = createMemoryAgent({
      agentId: "agent_1",
      coreMemory,
      factStore,
      promoter,
      embed,
      factsPerBriefing: 3,
    });
    vi.mocked(coreMemory.read).mockResolvedValue([]);
    vi.mocked(embed.embed).mockResolvedValue([]);
    vi.mocked(factStore.search).mockResolvedValue([]);

    await custom.prepareBriefing("x");
    expect(factStore.search).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 }),
    );
  });
});

describe("MemoryAgent.prepareCoreOnly", () => {
  it("returns core memory with an empty archival half (no embed / no fact search)", async () => {
    vi.mocked(coreMemory.read).mockResolvedValue([
      makeBlock("persona", "You are the team agent."),
    ]);

    const briefing = await agent.prepareCoreOnly();

    expect(briefing.systemPromptAppend).toContain("<core_memory>");
    expect(briefing.systemPromptAppend).toContain(
      "You are the team agent.",
    );
    // No archival half — human MCP path uses search_context on demand
    // instead of pre-loading hits against a placeholder intent.
    expect(briefing.userMessagePrefix).toBe("");
    expect(briefing.snapshot.fact_count).toBe(0);
    expect(briefing.snapshot.facts).toEqual([]);
    // Embed + fact search are the wasted-work pieces this method exists
    // to avoid — keep this assertion to lock that property in.
    expect(embed.embed).not.toHaveBeenCalled();
    expect(factStore.search).not.toHaveBeenCalled();
  });

  it("renders an empty <core_memory> envelope when the agent has no blocks", async () => {
    vi.mocked(coreMemory.read).mockResolvedValue([]);

    const briefing = await agent.prepareCoreOnly();

    expect(briefing.systemPromptAppend).toBe(
      "<core_memory>\n</core_memory>",
    );
    expect(briefing.snapshot.block_count).toBe(0);
  });
});

describe("MemoryAgent.searchArchival", () => {
  it("vector-searches with the query and returns archival envelope only", async () => {
    vi.mocked(embed.embed).mockResolvedValue([0.7, 0.8]);
    vi.mocked(factStore.search).mockResolvedValue([
      makeFact({ content: "Auth uses JWT.", fact_type: "decision" }),
    ]);

    const result = await agent.searchArchival("how does auth work");

    expect(result).toContain("<archival_memory>");
    expect(result).toContain("</archival_memory>");
    expect(result).toContain(
      '<fact type="decision" scope="ic" saved="2026-01-15">Auth uses JWT.</fact>',
    );
    expect(result).not.toContain("<core_memory>");
    expect(coreMemory.read).not.toHaveBeenCalled();
  });

  it("passes the query embedding to FactStore.search with the recall floor", async () => {
    vi.mocked(embed.embed).mockResolvedValue([0.5, 0.5]);
    vi.mocked(factStore.search).mockResolvedValue([]);

    await agent.searchArchival("retention metrics");

    expect(embed.embed).toHaveBeenCalledWith("retention metrics");
    expect(factStore.search).toHaveBeenCalledWith({
      agent_id: "agent_1",
      scope: ["ic", "team", "org"],
      embedding: [0.5, 0.5],
      limit: 10,
      min_similarity: 0.35,
    });
  });

  it("returns an empty envelope on zero hits (predictable shape)", async () => {
    vi.mocked(embed.embed).mockResolvedValue([]);
    vi.mocked(factStore.search).mockResolvedValue([]);

    const result = await agent.searchArchival("nothing matches");

    expect(result).toBe("<archival_memory></archival_memory>");
  });

  it("surfaces row-specific created_at in each saved=YYYY-MM-DD attribute", async () => {
    vi.mocked(embed.embed).mockResolvedValue([]);
    vi.mocked(factStore.search).mockResolvedValue([
      makeFact({
        id: "fact_old",
        content: "Old fact.",
        created_at: new Date("2025-08-12T00:00:00Z"),
      }),
      makeFact({
        id: "fact_recent",
        content: "Recent fact.",
        created_at: new Date("2026-04-30T00:00:00Z"),
      }),
    ]);

    const result = await agent.searchArchival("x");

    expect(result).toContain('saved="2025-08-12">Old fact.');
    expect(result).toContain('saved="2026-04-30">Recent fact.');
  });
});

describe("MemoryAgent.onTaskComplete", () => {
  it("promotes each fact returned by listBySessionId when the promoter approves", async () => {
    vi.mocked(factStore.listBySessionId).mockResolvedValue([
      makeFact({ id: "fact_a" }),
      makeFact({ id: "fact_b" }),
    ]);
    vi.mocked(promoter.evaluate)
      .mockResolvedValueOnce({
        promoted: true,
        target_scope: "team",
        reason: "broadly useful",
      } satisfies PromotionResult)
      .mockResolvedValueOnce({
        promoted: false,
        target_scope: null,
        reason: "narrow",
      } satisfies PromotionResult);
    vi.mocked(factStore.updateScope).mockResolvedValue(makeFact());

    await agent.onTaskComplete("sess_X");

    expect(factStore.listBySessionId).toHaveBeenCalledWith("sess_X");
    expect(factStore.updateScope).toHaveBeenCalledOnce();
    expect(factStore.updateScope).toHaveBeenCalledWith("fact_a", "team");
  });

  it("does not call updateScope when target_scope is null", async () => {
    vi.mocked(factStore.listBySessionId).mockResolvedValue([makeFact()]);
    vi.mocked(promoter.evaluate).mockResolvedValue({
      promoted: true, // invalid shape — defensive check ensures no update
      target_scope: null,
      reason: "weird",
    });

    await agent.onTaskComplete("sess_X");
    expect(factStore.updateScope).not.toHaveBeenCalled();
  });

  it("logs and continues when the promoter throws on one fact", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(factStore.listBySessionId).mockResolvedValue([
      makeFact({ id: "fact_a" }),
      makeFact({ id: "fact_b" }),
    ]);
    vi.mocked(promoter.evaluate)
      .mockRejectedValueOnce(new Error("LLM 500"))
      .mockResolvedValueOnce({
        promoted: true,
        target_scope: "team",
        reason: "ok",
      });
    vi.mocked(factStore.updateScope).mockResolvedValue(makeFact());

    await agent.onTaskComplete("sess_X");

    expect(factStore.updateScope).toHaveBeenCalledOnce();
    expect(factStore.updateScope).toHaveBeenCalledWith("fact_b", "team");
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("is a no-op when no facts touched the session", async () => {
    vi.mocked(factStore.listBySessionId).mockResolvedValue([]);
    await agent.onTaskComplete("sess_empty");
    expect(promoter.evaluate).not.toHaveBeenCalled();
    expect(factStore.updateScope).not.toHaveBeenCalled();
  });

  describe("with promotionEventRepo wired (M8.D audit log)", () => {
    let promotionEventRepo: MemoryPromotionEventRepository;
    let auditedAgent: MemoryAgent;

    beforeEach(() => {
      promotionEventRepo = {
        create: vi.fn(),
        listByOwner: vi.fn(),
        findById: vi.fn(),
      } as unknown as MemoryPromotionEventRepository;
      auditedAgent = createMemoryAgent({
        agentId: "agent_1",
        coreMemory,
        factStore,
        promoter,
        embed,
        promotionEventRepo,
      });
    });

    it("writes a non-rejected event when a fact is promoted", async () => {
      vi.mocked(factStore.listBySessionId).mockResolvedValue([
        makeFact({ id: "fact_a", scope: "ic", source_session_ids: ["sess_X"] }),
      ]);
      vi.mocked(promoter.evaluate).mockResolvedValue({
        promoted: true,
        target_scope: "team",
        reason: "broadly useful",
      });
      vi.mocked(factStore.updateScope).mockResolvedValue(makeFact());

      await auditedAgent.onTaskComplete("sess_X");

      expect(promotionEventRepo.create).toHaveBeenCalledOnce();
      const arg = vi.mocked(promotionEventRepo.create).mock.calls[0][0];
      expect(arg).toMatchObject({
        fact_id: "fact_a",
        from_scope: "ic",
        to_scope: "team",
        origin_agent_id: "agent_1",
        promoter_reason: "broadly useful",
        source_session_ids: ["sess_X"],
        rejected: false,
      });
      expect(arg.id).toMatch(/^mpe_/);
    });

    it("writes a rejected event with to_scope = from_scope when promoter declines", async () => {
      vi.mocked(factStore.listBySessionId).mockResolvedValue([
        makeFact({ id: "fact_b", scope: "ic" }),
      ]);
      vi.mocked(promoter.evaluate).mockResolvedValue({
        promoted: false,
        target_scope: null,
        reason: "too narrow",
      });

      await auditedAgent.onTaskComplete("sess_X");

      expect(promotionEventRepo.create).toHaveBeenCalledOnce();
      const arg = vi.mocked(promotionEventRepo.create).mock.calls[0][0];
      expect(arg).toMatchObject({
        fact_id: "fact_b",
        from_scope: "ic",
        to_scope: "ic",
        promoter_reason: "too narrow",
        rejected: true,
      });
      expect(factStore.updateScope).not.toHaveBeenCalled();
    });

    it("writes one event per fact in the session", async () => {
      vi.mocked(factStore.listBySessionId).mockResolvedValue([
        makeFact({ id: "fact_a" }),
        makeFact({ id: "fact_b" }),
        makeFact({ id: "fact_c" }),
      ]);
      vi.mocked(promoter.evaluate).mockResolvedValue({
        promoted: false,
        target_scope: null,
        reason: "narrow",
      });

      await auditedAgent.onTaskComplete("sess_X");
      expect(promotionEventRepo.create).toHaveBeenCalledTimes(3);
    });

    it("does NOT write an event when promoter.evaluate throws (consistent with skip-and-continue)", async () => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.mocked(factStore.listBySessionId).mockResolvedValue([makeFact()]);
      vi.mocked(promoter.evaluate).mockRejectedValue(new Error("LLM 500"));

      await auditedAgent.onTaskComplete("sess_X");

      expect(promotionEventRepo.create).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });
});
