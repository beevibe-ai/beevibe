import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryFact } from "../../domain/memory.js";
import type { EmbeddingService } from "../../ports/embedding-service.js";
import type { LlmProvider } from "../../ports/llm-provider.js";
import type { MemoryFactRepository } from "../../ports/memory-fact-repo.js";
import { FactStore, SIMILARITY_MERGE_THRESHOLD } from "./fact-store.js";

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "fact_existing",
    agent_id: "agent_1",
    scope: "ic",
    fact_type: "preference",
    content: "User prefers pnpm.",
    embedding: new Array<number>(1536).fill(0),
    source_session_ids: ["sess_old"],
    created_at: new Date(),
    ...overrides,
  };
}

let repo: MemoryFactRepository;
let embed: EmbeddingService;
let llm: LlmProvider;
let store: FactStore;

beforeEach(() => {
  repo = {
    findById: vi.fn(),
    findByIds: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    searchByVector: vi.fn(),
    listByAgentScope: vi.fn(),
    listBySessionId: vi.fn(),
  };
  embed = {
    type: "fake",
    embed: vi.fn(),
    embedBatch: vi.fn(),
  };
  llm = {
    type: "fake",
    complete: vi.fn(),
    completeStructured: vi.fn(),
  };
  store = new FactStore({ repo, embed, llm });
});

describe("FactStore.addOrMerge — create path", () => {
  it("creates a new fact when nothing crosses the similarity threshold", async () => {
    vi.mocked(embed.embed).mockResolvedValue(new Array<number>(1536).fill(0.1));
    vi.mocked(repo.searchByVector).mockResolvedValue([]);
    vi.mocked(repo.create).mockImplementation(async (input) => ({
      ...input,
      created_at: new Date(),
    }));

    const fact = await store.addOrMerge(
      "agent_1",
      "sess_new",
      "Prefers pnpm over npm",
      "preference",
      "ic",
    );

    expect(repo.searchByVector).toHaveBeenCalledWith({
      agent_id: "agent_1",
      scope: "ic",
      embedding: expect.any(Array),
      limit: 1,
      min_similarity: SIMILARITY_MERGE_THRESHOLD,
      fact_types: ["preference"],
    });
    expect(repo.create).toHaveBeenCalledOnce();
    const createInput = vi.mocked(repo.create).mock.calls[0]![0];
    expect(createInput.id).toMatch(/^fact_/);
    expect(createInput.agent_id).toBe("agent_1");
    expect(createInput.scope).toBe("ic");
    expect(createInput.fact_type).toBe("preference");
    expect(createInput.content).toBe("Prefers pnpm over npm");
    expect(createInput.embedding).toHaveLength(1536);
    expect(createInput.source_session_ids).toEqual(["sess_new"]);
    expect(llm.complete).not.toHaveBeenCalled();
    expect(fact.content).toBe("Prefers pnpm over npm");
  });

  it("stamps the scope from the caller (team agent → team-scoped fact)", async () => {
    vi.mocked(embed.embed).mockResolvedValue(new Array<number>(1536).fill(0.1));
    vi.mocked(repo.searchByVector).mockResolvedValue([]);
    vi.mocked(repo.create).mockImplementation(async (input) => ({
      ...input,
      created_at: new Date(),
    }));

    await store.addOrMerge("agent_team", "sess_new", "Team prefers X", "preference", "team");

    expect(repo.searchByVector).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "team" }),
    );
    const createInput = vi.mocked(repo.create).mock.calls[0]![0];
    expect(createInput.scope).toBe("team");
  });
});

describe("FactStore.addOrMerge — merge path", () => {
  it("LLM-merges + re-embeds + unions session ids when a neighbor is above threshold", async () => {
    const existing = makeFact({
      content: "User prefers pnpm",
      source_session_ids: ["sess_A"],
    });
    vi.mocked(embed.embed)
      .mockResolvedValueOnce(new Array<number>(1536).fill(0.2)) // first — initial content
      .mockResolvedValueOnce(new Array<number>(1536).fill(0.5)); // second — merged content
    vi.mocked(repo.searchByVector).mockResolvedValue([existing]);
    vi.mocked(llm.complete).mockResolvedValue({
      text: "User prefers pnpm and explicitly avoids npm.",
      usage: { input_tokens: 10, output_tokens: 10, model: "fake" },
    });
    vi.mocked(repo.update).mockImplementation(async (_id, patch) => ({
      ...existing,
      ...patch,
    }));

    const merged = await store.addOrMerge(
      "agent_1",
      "sess_B",
      "Prefers pnpm and won't use npm",
      "preference",
      "ic",
    );

    expect(llm.complete).toHaveBeenCalledOnce();
    const llmCall = vi.mocked(llm.complete).mock.calls[0]![0];
    expect(llmCall.prompt).toContain("User prefers pnpm");
    expect(llmCall.prompt).toContain("Prefers pnpm and won't use npm");
    expect(llmCall.temperature).toBe(0.2);

    expect(embed.embed).toHaveBeenCalledTimes(2);
    expect(repo.create).not.toHaveBeenCalled();

    const updateArgs = vi.mocked(repo.update).mock.calls[0]!;
    expect(updateArgs[0]).toBe(existing.id);
    expect(updateArgs[1].content).toBe("User prefers pnpm and explicitly avoids npm.");
    expect(updateArgs[1].embedding).toHaveLength(1536);
    expect(updateArgs[1].source_session_ids).toEqual(["sess_A", "sess_B"]);
    expect(merged.content).toContain("avoids npm");
  });

  it("dedupes sessionId when merging if the same session already appears on the neighbor", async () => {
    const existing = makeFact({ source_session_ids: ["sess_A", "sess_B"] });
    vi.mocked(embed.embed).mockResolvedValue(new Array<number>(1536).fill(0.1));
    vi.mocked(repo.searchByVector).mockResolvedValue([existing]);
    vi.mocked(llm.complete).mockResolvedValue({
      text: "merged",
      usage: { input_tokens: 1, output_tokens: 1, model: "fake" },
    });
    vi.mocked(repo.update).mockImplementation(async (_id, patch) => ({
      ...existing,
      ...patch,
    }));

    await store.addOrMerge("agent_1", "sess_B", "same session again", "preference", "ic");

    const updatePatch = vi.mocked(repo.update).mock.calls[0]![1];
    expect(updatePatch.source_session_ids).toEqual(["sess_A", "sess_B"]);
  });

  it("trims whitespace from the LLM merge output before persisting", async () => {
    const existing = makeFact();
    vi.mocked(embed.embed).mockResolvedValue(new Array<number>(1536).fill(0.1));
    vi.mocked(repo.searchByVector).mockResolvedValue([existing]);
    vi.mocked(llm.complete).mockResolvedValue({
      text: "   merged text  \n",
      usage: { input_tokens: 1, output_tokens: 1, model: "fake" },
    });
    vi.mocked(repo.update).mockImplementation(async (_id, patch) => ({
      ...existing,
      ...patch,
    }));

    await store.addOrMerge("agent_1", "sess_new", "new content", "preference", "ic");
    expect(vi.mocked(repo.update).mock.calls[0]![1].content).toBe("merged text");
  });
});

describe("FactStore thin delegations", () => {
  it("updateScope calls repo.update with just scope", async () => {
    vi.mocked(repo.update).mockResolvedValue(makeFact({ scope: "team" }));
    await store.updateScope("fact_x", "team");
    expect(repo.update).toHaveBeenCalledWith("fact_x", { scope: "team" });
  });

  it("search delegates to repo.searchByVector", async () => {
    vi.mocked(repo.searchByVector).mockResolvedValue([]);
    await store.search({
      agent_id: "agent_1",
      scope: "ic",
      embedding: [],
      limit: 5,
    });
    expect(repo.searchByVector).toHaveBeenCalled();
  });

  it("listBySessionId delegates to repo.listBySessionId", async () => {
    vi.mocked(repo.listBySessionId).mockResolvedValue([]);
    await store.listBySessionId("sess_abc");
    expect(repo.listBySessionId).toHaveBeenCalledWith("sess_abc");
  });
});
