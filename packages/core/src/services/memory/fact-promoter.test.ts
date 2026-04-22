import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryFact } from "../../domain/memory.js";
import type { LlmProvider } from "../../ports/llm-provider.js";
import { FactPromoter, type PromotionResult } from "./fact-promoter.js";

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: "fact_1",
    agent_id: "agent_1",
    scope: "ic",
    fact_type: "pattern",
    content: "Production deploys always run on Tuesdays to align with QA.",
    embedding: [],
    source_session_ids: ["sess_1"],
    created_at: new Date(),
    ...overrides,
  };
}

let llm: LlmProvider;
let promoter: FactPromoter;

beforeEach(() => {
  llm = {
    type: "fake",
    complete: vi.fn(),
    completeStructured: vi.fn(),
  };
  promoter = new FactPromoter({ llm });
});

describe("FactPromoter.evaluate", () => {
  it("skips the LLM for org-scoped facts and returns promoted=false", async () => {
    const fact = makeFact({ scope: "org" });
    const result = await promoter.evaluate(fact);

    expect(result.promoted).toBe(false);
    expect(result.target_scope).toBeNull();
    expect(llm.completeStructured).not.toHaveBeenCalled();
  });

  it("calls completeStructured with the promotion schema at temperature 0", async () => {
    vi.mocked(llm.completeStructured).mockResolvedValue({
      value: {
        promoted: false,
        target_scope: "none",
        reason: "narrow detail",
      },
      usage: { input_tokens: 10, output_tokens: 10, model: "fake" },
    });

    await promoter.evaluate(makeFact());

    const callArgs = vi.mocked(llm.completeStructured).mock.calls[0]![0];
    expect(callArgs.temperature).toBe(0);
    expect(callArgs.schema_name).toBe("promotion_decision");
    expect(callArgs.maxTokens).toBeGreaterThan(0);
    expect(callArgs.system.toLowerCase()).toContain("promote");
    expect(callArgs.prompt).toContain("Production deploys always run on Tuesdays");
    expect(callArgs.prompt).toContain("pattern");
    expect(callArgs.prompt).toContain("ic");
  });

  it("returns the LLM decision verbatim when the target is a valid upward step", async () => {
    vi.mocked(llm.completeStructured).mockResolvedValue({
      value: {
        promoted: true,
        target_scope: "team",
        reason: "Broadly useful pattern across teammates.",
      },
      usage: { input_tokens: 10, output_tokens: 10, model: "fake" },
    });

    const result: PromotionResult = await promoter.evaluate(makeFact({ scope: "ic" }));
    expect(result.promoted).toBe(true);
    expect(result.target_scope).toBe("team");
    expect(result.reason).toContain("useful");
  });

  it("translates 'none' sentinel to null in PromotionResult", async () => {
    vi.mocked(llm.completeStructured).mockResolvedValue({
      value: {
        promoted: false,
        target_scope: "none",
        reason: "narrow",
      },
      usage: { input_tokens: 1, output_tokens: 1, model: "fake" },
    });
    const result = await promoter.evaluate(makeFact({ scope: "ic" }));
    expect(result.promoted).toBe(false);
    expect(result.target_scope).toBeNull();
  });

  it("rejects an LLM proposal that does not widen scope (ic → none while promoted=true) as invalid", async () => {
    vi.mocked(llm.completeStructured).mockResolvedValue({
      value: {
        promoted: true,
        target_scope: "none",
        reason: "noisy",
      },
      usage: { input_tokens: 1, output_tokens: 1, model: "fake" },
    });

    const result = await promoter.evaluate(makeFact({ scope: "ic" }));
    expect(result.promoted).toBe(false);
    expect(result.target_scope).toBeNull();
    expect(result.reason).toContain("invalid");
  });

  it("rejects team → team as invalid (no widening)", async () => {
    vi.mocked(llm.completeStructured).mockResolvedValue({
      value: {
        promoted: true,
        target_scope: "team",
        reason: "team-wide",
      },
      usage: { input_tokens: 1, output_tokens: 1, model: "fake" },
    });

    const result = await promoter.evaluate(makeFact({ scope: "team" }));
    expect(result.promoted).toBe(false);
    expect(result.target_scope).toBeNull();
  });

  it("allows team → org as a valid upward step", async () => {
    vi.mocked(llm.completeStructured).mockResolvedValue({
      value: {
        promoted: true,
        target_scope: "org",
        reason: "organization-wide relevance",
      },
      usage: { input_tokens: 1, output_tokens: 1, model: "fake" },
    });

    const result = await promoter.evaluate(makeFact({ scope: "team" }));
    expect(result.promoted).toBe(true);
    expect(result.target_scope).toBe("org");
  });
});
