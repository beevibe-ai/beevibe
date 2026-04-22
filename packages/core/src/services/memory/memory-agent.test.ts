import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreMemoryBlock } from "../../domain/core-memory.js";
import type { MemoryFact } from "../../domain/memory.js";
import type { EmbeddingService } from "../../ports/embedding-service.js";
import type { CoreMemory } from "./core-memory.js";
import type { FactPromoter, PromotionResult } from "./fact-promoter.js";
import type { FactStore } from "./fact-store.js";
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

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "fact_1",
    agent_id: "agent_1",
    scope: "ic",
    fact_type: "preference",
    content: "Uses pnpm.",
    embedding: [],
    source_session_ids: ["sess_1"],
    created_at: new Date(),
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

    expect(briefing).toContain("<core_memory>");
    expect(briefing).toContain('<block name="persona">Senior infra engineer.</block>');
    expect(briefing).toContain('<block name="domain">TypeScript, Postgres.</block>');
    expect(briefing).toContain("<archival_memory>");
    expect(briefing).toContain(
      '<fact type="preference" scope="ic">Prefers pnpm over npm.</fact>',
    );
    expect(briefing).toContain(
      '<fact type="gotcha" scope="team">DB schema is on public.</fact>',
    );
    expect(briefing).toContain("<memory_tools>");
    expect(briefing).toContain("save_memory");
    expect(briefing).toContain("update_core_memory");
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
    expect(briefing).toContain("knows &lt;html&gt; &amp; JSX");
    expect(briefing).toContain("works with &lt;div&gt; tags");
    // Raw '<' characters must only appear in XML tags we generated, not in content.
    const contentOnly = briefing
      .replace(/<\/?core_memory>|<\/?archival_memory>|<\/?memory_tools>/g, "")
      .replace(/<block [^>]+>/g, "")
      .replace(/<\/block>/g, "")
      .replace(/<fact [^>]+>/g, "")
      .replace(/<\/fact>/g, "");
    expect(contentOnly).not.toMatch(/<div>/);
    expect(contentOnly).not.toMatch(/<html>/);
  });

  it("renders empty <core_memory> / <archival_memory> when there's nothing to show", async () => {
    vi.mocked(coreMemory.read).mockResolvedValue([]);
    vi.mocked(embed.embed).mockResolvedValue([]);
    vi.mocked(factStore.search).mockResolvedValue([]);

    const briefing = await agent.prepareBriefing("anything");
    expect(briefing).toMatch(/<core_memory>\s*<\/core_memory>/);
    expect(briefing).toMatch(/<archival_memory>\s*<\/archival_memory>/);
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
});
